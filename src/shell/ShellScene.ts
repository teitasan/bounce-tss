import * as Phaser from 'phaser';
import { ARENA } from '../config';
import { ui } from '../ui';
import { B, L, PILLARS, R, SPAWNS, T, moveShell, resolveCircle, type Mover } from './arena';
import { drawShell, shade, shellSvg, type Marks } from './visuals';
import { CARD_RULE, Hand, MATCH, SHELLS, SPLIT_ANGLE, SPLIT_CHILD, STARTER_DECK, draftCandidates, type ShellSpec, type ShellType } from './cards';
import { EFFECTS, EFFECT_IDS, Rotation, SHELL_COUNT, buildSpec, effectCandidates, emptyLevels, starterLoadout, summary, type EffectId, type ShellLevels } from './custom';

/** plain: 甲羅バトル / cards: カード甲羅 / custom: カスタム甲羅 */
export type ShellMode = 'plain' | 'cards' | 'custom';

/** 甲羅バトルの数値（甲羅ごとの性能は cards.ts の SHELLS） */
export const SHELL = {
  hp: 3,
  actorRadius: 14, // 見た目の大きさ。移動・壁・キャラ同士の押し合いに使う
  hurtRadius: 11, // 甲羅が当たる判定。見た目より少し小さくして、かすり避けを許す
  moveSpeed: 230,
  invincible: 1.2, // 被弾後の無敵（秒）
  knockback: 420,
  maxStock: 2, // 手持ち（周回している甲羅）の最大数
  refillTime: 2.5, // 手持ちが1個戻るまでの秒数
  orbitRadius: 30, // 周回の半径
  orbitSpeed: 4.5, // 周回の速さ（rad/s）
  throwCooldown: 0.35,
  ownerGrace: 0.3, // 投げた直後に自分へ当たらない時間（秒）
  homingStopDistance: 110, // 追尾甲羅はこの距離まで相手に近づくと、それ以降は曲がらない
  bots: 3,
  botThrowInterval: [1.5, 3], // CPU が次に投げるまでの秒数（最小, 最大）
  countdown: 2.4, // ラウンド開始の 3・2・1（ラウンド紹介を見せる時間でもある）
};

const COLORS = [0x6ef2ff, 0xff6b6b, 0xffd166, 0xb388ff];
const NAMES = ['あなた', 'CPU1', 'CPU2', 'CPU3'];

interface Actor {
  id: number;
  name: string;
  color: number;
  bot: boolean;
  x: number;
  y: number;
  kx: number;
  ky: number;
  aim: number;
  hp: number;
  inv: number;
  cooldown: number;
  /** 手持ちの甲羅の数。自分の周りを回り、盾と体当たりの当たり判定を持つ */
  stock: number;
  refill: number;
  orbitPhase: number;
  alive: boolean;
  wins: number;
  hand: Hand | null;
  /** カード甲羅の試合を通して育てるデッキ */
  deck: ShellType[];
  /** カスタム甲羅：3つの甲羅それぞれの効果レベルと、そこから作った性能 */
  loadout: ShellLevels[];
  specs: ShellSpec[];
  rot: Rotation | null;
  /** カスタム甲羅：甲羅ごとの、手元にあるか・補充までの残り秒数 */
  ready: boolean[];
  slotRefill: number[];
  ai: { think: number; moveX: number; moveY: number; throwTimer: number; strafe: number; pick: number };
}

interface Shell extends Mover {
  spec: ShellSpec;
  owner: Actor;
  age: number;
  bounces: number;
  /** 同じ1投から出た甲羅（分裂の親子）は同じ値。互いにはぶつからない */
  family: number;
  /** 残像用の過去の位置（古い順） */
  trail: { x: number; y: number }[];
  /** 今の速さ（加速甲羅は反射のたびに上がる） */
  speed: number;
  /** 割れずに通り抜けられる残り回数（貫通甲羅） */
  pierceLeft: number;
  /** 割れずに跳ね返れる残り回数（反発）と、跳ね返った直後に同じ相手と重ならないための猶予（秒） */
  reboundLeft: number;
  recoil: number;
  /** 追尾をやめたか（相手に近づいた後はまっすぐ進む） */
  homingOff: boolean;
  /** 追尾で今向かっている相手（目印を出す） */
  target?: Actor;
  /** 通り抜けた相手（'f'+family は甲羅、'o'+id は周回甲羅）。同じ相手とは二度ぶつからない */
  passed: Set<string>;
  dead: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  color: number;
}

/** 描画用に1コマぶんの状態を写したもの。そのまま描くのにもリプレイの録画にも使う */
interface Frame {
  actors: { x: number; y: number; aim: number; alive: boolean; inv: number; hp: number; color: number; targeted: boolean; orbits: { x: number; y: number; spec: ShellSpec; angle: number }[] }[];
  shells: { x: number; y: number; angle: number; spec: ShellSpec; fade: number; ownerColor: number; trail: { x: number; y: number }[]; live: Partial<Marks> }[];
  particles: { x: number; y: number; r: number; color: number; a: number }[];
  glints: { x: number; y: number; tx: number; ty: number; k: number; color: number }[];
  rings: { x: number; y: number; k: number; color: number }[];
}

/** リプレイ：脱落の何コマ前から何コマ後までを、どの速さで流すか */
const REPLAY = { before: 60, after: 24, speed: 0.7, zoomMin: 1.1, zoomMax: 2.1, bufferFrames: 240 };

/** 脱落の記録：どこで・録画の何コマ目で・誰が誰に */
interface Kill {
  x: number;
  y: number;
  idx: number;
  victim: number;
  killer: number;
}

type State = 'countdown' | 'play' | 'paused' | 'result' | 'draft';

const TRAIL_LENGTH = 8; // 残像に使う過去の位置の数（1フレームに1つ）

const $ = (id: string) => document.getElementById(id)!;
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export class ShellScene extends Phaser.Scene {
  private g!: Phaser.GameObjects.Graphics;
  /** 加算合成で光らせる演出（残像・光・粒子）用 */
  private fx!: Phaser.GameObjects.Graphics;
  /** 壁や柱で跳ねた瞬間に壁沿いに走る光 */
  private glints: { x: number; y: number; tx: number; ty: number; life: number; color: number }[] = [];
  /** 当たった瞬間に時間を止める残り秒数 */
  private hitstop = 0;
  /** 決着後、スローモーションで勝者に寄っている残り秒数（終わったら結果を出す） */
  private winnerFocus = 0;
  /** リプレイ用の録画（直近 REPLAY.bufferFrames コマ）。recBase は rec[0] の通し番号 */
  private rec: Frame[] = [];
  private recBase = 0;
  /** 直近の脱落（リプレイの中心） */
  private lastKill: Kill | null = null;
  /** 脱落の少し後にリプレイを始める。then は終わった後の流れ */
  private pendingReplay: { t: number; kill: Kill; then: 'live' | 'winner' } | null = null;
  private replay: { frames: Frame[]; pos: number; then: 'live' | 'winner'; kill: Kill } | null = null;
  private label!: Phaser.GameObjects.Text;
  private keys!: Record<'W' | 'A' | 'S' | 'D' | 'SPACE', Phaser.Input.Keyboard.Key>;
  private state: State = 'countdown';
  private countdown = 0;
  private actors: Actor[] = [];
  private shells: Shell[] = [];
  private particles: Particle[] = [];
  private rings: { x: number; y: number; life: number; color: number }[] = [];
  private hudTimer = 0;
  private round = 0;
  private throwSeq = 0;
  /** 分裂でこのフレームに生まれた甲羅（更新ループの後で shells に足す） */
  private spawnQueue: Shell[] = [];
  /** 自分が脱落した後、R で早送りする */
  private fast = false;
  private matchOver = false;
  /** デバッグウィンドウ（カスタム甲羅で Tab） */
  private debugOpen = false;
  private debug = { invincible: false, cpuHold: false, hitbox: false };

  constructor(
    key = 'shell',
    private readonly mode: ShellMode = 'plain',
  ) {
    super(key);
  }

  private get cards() {
    return this.mode === 'cards';
  }

  private get custom() {
    return this.mode === 'custom';
  }

  /** ラウンドの合間にドラフトがあり、先に MATCH.winTarget 勝で優勝するモード */
  private get drafting() {
    return this.mode !== 'plain';
  }

  private get maxStock() {
    return this.custom ? SHELL_COUNT : SHELL.maxStock;
  }

  create() {
    this.drawArena();
    this.g = this.add.graphics().setDepth(10);
    this.fx = this.add.graphics().setDepth(11).setBlendMode(Phaser.BlendModes.ADD);
    // 寄ったときに試合場の外が映らないように
    this.cameras.main.setBounds(0, 0, ARENA.width, ARENA.height);
    this.label = this.add
      .text(ARENA.width / 2, ARENA.height / 2 - 120, '', { fontFamily: 'system-ui, sans-serif', fontSize: '48px', fontStyle: 'bold', color: '#ffffff', stroke: '#000', strokeThickness: 6 })
      .setOrigin(0.5)
      .setDepth(30);
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,SPACE') as ShellScene['keys'];
    const kb = this.input.keyboard!;
    kb.on('keydown-ESC', () => this.togglePause());
    if (this.custom) {
      kb.addCapture('TAB');
      kb.on('keydown-TAB', () => {
        this.debugOpen = !this.debugOpen;
        this.renderDebug();
      });
    }
    kb.on('keydown-R', () => {
      if (this.replay) return this.endReplay();
      if (this.state === 'result' && !$('shell-result').hidden) this.proceed();
      else if (this.state === 'play' && !this.actors[0].alive) {
        // カード甲羅は勝敗がドラフトに関わるので、飛ばさずに早送りする
        if (this.drafting) this.fast = !this.fast;
        else this.newRound();
      }
    });
    if (this.drafting) {
      kb.on('keydown-ONE', () => this.draftSelect(0));
      kb.on('keydown-TWO', () => this.draftSelect(1));
      kb.on('keydown-THREE', () => this.draftSelect(2));
      kb.on('keydown-FOUR', () => this.draftSelect(3));
      kb.on('keydown-N', () => this.draftPass());
    }
    if (this.cards && CARD_RULE.pick) {
      const select = (i: number) => {
        const h = this.actors[0].hand;
        if (h) h.selected = i;
        this.renderHand();
      };
      kb.on('keydown-ONE', () => select(0));
      kb.on('keydown-TWO', () => select(1));
      kb.on('keydown-THREE', () => select(2));
      kb.on('keydown-Q', () => select((this.actors[0].hand!.selected + 2) % 3));
      kb.on('keydown-E', () => select((this.actors[0].hand!.selected + 1) % 3));
      this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => select((this.actors[0].hand!.selected + (dy > 0 ? 1 : 2)) % 3));
    }
    this.input.on('pointerdown', () => {
      if (this.replay) this.endReplay();
    });
    this.bindDom();
    // モード切替で戻ってきたとき、共有している DOM をこのモードにつなぎ直す
    this.events.on('wake', () => this.bindDom());

    this.actors = NAMES.slice(0, 1 + SHELL.bots).map((name, i) => ({
      id: i,
      name,
      color: COLORS[i],
      bot: i > 0,
      x: 0,
      y: 0,
      kx: 0,
      ky: 0,
      aim: 0,
      hp: 0,
      inv: 0,
      cooldown: 0,
      stock: 0,
      refill: 0,
      orbitPhase: 0,
      alive: true,
      wins: 0,
      hand: null,
      deck: [...STARTER_DECK],
      loadout: starterLoadout(),
      specs: [],
      rot: null,
      ready: [],
      slotRefill: [],
      ai: { think: 0, moveX: 0, moveY: 0, throwTimer: 0, strafe: 1, pick: 0 },
    }));
    this.newRound();
  }

  private bindDom() {
    $('shell-next').onclick = () => this.proceed();
    $('shell-result').hidden = this.state !== 'result';
    $('draft').hidden = this.state !== 'draft';
    $('replay').hidden = !this.replay;
    if (this.state === 'draft') this.renderDraft();
    ui.setPaused(this.state === 'paused');
    // 他のモードが共有の DOM を書き換えているかもしれないので作り直す
    this.hudBuilt = false;
    this.handKey = '';
    this.introRound = -1;
    this.renderHud();
    this.renderHand();
    this.renderIntro();
    this.renderDebug();
  }

  private newRound() {
    this.round++;
    this.fast = false;
    this.deadOrder = [];
    $('shell-result').hidden = true;
    this.shells = [];
    this.particles = [];
    this.rings = [];
    this.glints = [];
    this.hitstop = 0;
    this.winnerFocus = 0;
    this.rec = [];
    this.recBase = 0;
    this.lastKill = null;
    this.pendingReplay = null;
    this.replay = null;
    $('replay').hidden = true;
    const cam = this.cameras.main;
    cam.setZoom(1);
    cam.centerOn(ARENA.width / 2, ARENA.height / 2);
    this.actors.forEach((a, i) => {
      const sp = SPAWNS[i % SPAWNS.length];
      Object.assign(a, { x: sp.x, y: sp.y, kx: 0, ky: 0, hp: SHELL.hp, inv: 0, cooldown: 0, alive: true });
      Object.assign(a, { stock: this.maxStock, refill: SHELL.refillTime, orbitPhase: Math.random() * Math.PI * 2 });
      a.aim = Math.atan2(ARENA.height / 2 - a.y, ARENA.width / 2 - a.x);
      a.hand = this.cards ? new Hand(a.deck) : null;
      a.rot = this.custom ? new Rotation() : null;
      a.specs = a.loadout.map((lv, i) => buildSpec(lv, i));
      a.ready = Array(SHELL_COUNT).fill(true);
      a.slotRefill = Array(SHELL_COUNT).fill(0);
      a.ai = { think: 0, moveX: 0, moveY: 0, throwTimer: 0.5 + Math.random(), strafe: Math.random() < 0.5 ? 1 : -1, pick: 0 };
    });
    this.state = 'countdown';
    this.countdown = SHELL.countdown;
    this.renderHand();
  }

  private togglePause() {
    if (this.state === 'play') this.state = 'paused';
    else if (this.state === 'paused') this.state = 'play';
    ui.setPaused(this.state === 'paused');
  }

  update(_t: number, deltaMs: number) {
    const realDt = Math.min(deltaMs / 1000, 1 / 30);
    let dt = realDt;
    const me = this.actors[0];
    this.updateHumanAim(me);

    // リプレイ：裏で試合は進めたまま、録画を拡大して流す
    if (this.pendingReplay) {
      this.pendingReplay.t -= realDt;
      if (this.pendingReplay.t <= 0) {
        const p = this.pendingReplay;
        this.pendingReplay = null;
        this.startReplay(p.kill, p.then);
      }
    }
    if (this.replay) {
      this.replay.pos += realDt * 60 * REPLAY.speed;
      if (this.replay.pos >= this.replay.frames.length - 1) this.endReplay();
      else this.aimReplayCamera(0.12);
    }

    // ヒットストップ中は時間を止めて描画だけする（録画には同じコマを重ねて、リプレイでも止まって見せる）
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      this.record();
      this.render();
      return;
    }
    // 決着後、勝者に寄っている間はスローモーション。終わったら結果を出す
    if (this.winnerFocus > 0) {
      dt *= 0.3;
      this.winnerFocus -= realDt;
      if (this.winnerFocus <= 0) this.showResult();
    }

    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) this.state = 'play';
      this.moveActors(dt, false);
    } else if (this.state === 'play' || this.state === 'result') {
      const steps = this.fast && this.state === 'play' ? 4 : 1;
      for (let i = 0; i < steps; i++) {
        for (const a of this.actors) a.hand?.update(dt);
        this.moveActors(dt, this.state === 'play');
        if (this.state === 'play') this.updateOrbitContacts();
        this.updateShells(dt);
        if (this.state === 'play') this.checkRoundEnd();
        this.record();
      }
    }
    this.updateParticles(dt);
    this.renderIntro();
    // 優勝の紙吹雪
    if (this.confetti > 0 && this.roundWinner) {
      this.confetti -= realDt;
      if (Math.random() < 0.5) {
        const w = this.roundWinner;
        const cols = [0xff6b81, 0xffd166, 0x6ef2ff, 0x8dff7a, 0xb388ff];
        this.burst(w.x + (Math.random() - 0.5) * 300, w.y + (Math.random() - 0.5) * 200, 8, cols[Math.floor(Math.random() * cols.length)], 200, 0.9, 2.5);
      }
    }

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.renderHud();
      this.renderHand();
    }
    this.render();
  }

  // ---------------- 入力・AI ----------------

  private updateHumanAim(me: Actor) {
    const p = this.input.activePointer;
    if (me.alive) me.aim = Math.atan2(p.worldY - me.y, p.worldX - me.x);
  }

  /** カスタム甲羅：手元にある甲羅のうち、順番が一番早いもの */
  private currentSlot(a: Actor): number | null {
    if (!a.rot) return null;
    return a.rot.order().find((i) => a.ready[i]) ?? null;
  }

  /** 次に投げる甲羅。投げられるものがなければ null */
  private currentSpec(a: Actor): ShellSpec | null {
    if (a.rot) {
      const slot = this.currentSlot(a);
      return slot === null ? null : a.specs[slot];
    }
    if (!a.hand) return SHELLS.normal;
    const t = a.hand.slots[a.bot ? a.ai.pick : a.hand.selected];
    return t ? SHELLS[t] : null;
  }

  /** 次に投げる甲羅を使ったことにする */
  private consume(a: Actor) {
    if (a.rot) {
      const slot = this.currentSlot(a)!;
      a.rot.take(slot);
      a.ready[slot] = false;
      a.slotRefill[slot] = SHELL.refillTime;
    } else if (a.hand) {
      a.hand.use(a.bot ? a.ai.pick : a.hand.selected);
    }
    if (!this.custom) a.stock--;
  }

  private moveActors(dt: number, canThrow: boolean) {
    const damp = Math.exp(-10 * dt);
    for (const a of this.actors) {
      if (!a.alive) continue;
      let mx = 0;
      let my = 0;
      if (!a.bot) {
        if (this.keys.A.isDown) mx -= 1;
        if (this.keys.D.isDown) mx += 1;
        if (this.keys.W.isDown) my -= 1;
        if (this.keys.S.isDown) my += 1;
      } else if (canThrow) {
        this.think(a, dt);
        mx = a.ai.moveX;
        my = a.ai.moveY;
      }
      const len = Math.hypot(mx, my) || 1;
      a.x += ((mx / len) * SHELL.moveSpeed + a.kx) * dt;
      a.y += ((my / len) * SHELL.moveSpeed + a.ky) * dt;
      a.kx *= damp;
      a.ky *= damp;
      a.inv = Math.max(0, a.inv - dt);
      a.cooldown -= dt;
      resolveCircle(a, SHELL.actorRadius);
      a.orbitPhase += SHELL.orbitSpeed * dt;
      if (this.custom) {
        for (let i = 0; i < SHELL_COUNT; i++) {
          if (a.ready[i]) continue;
          a.slotRefill[i] -= dt;
          if (a.slotRefill[i] <= 0) a.ready[i] = true;
        }
        a.stock = a.ready.filter(Boolean).length;
      } else if (a.stock < SHELL.maxStock) {
        a.refill -= dt;
        if (a.refill <= 0) {
          a.stock++;
          a.refill = SHELL.refillTime;
        }
      } else {
        a.refill = SHELL.refillTime;
      }

      if (!canThrow) continue;
      const wantThrow = a.bot ? a.ai.throwTimer <= 0 && !this.debug.cpuHold : this.input.activePointer.leftButtonDown() || this.keys.SPACE.isDown;
      if (!wantThrow || a.cooldown > 0 || a.stock <= 0) continue;
      const spec = this.currentSpec(a);
      if (!spec) continue;
      this.consume(a);
      this.throwShell(a, spec);
    }
    // 体同士の重なりを解消
    const live = this.actors.filter((a) => a.alive);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const min = SHELL.actorRadius * 2;
        const d = Math.hypot(dx, dy);
        if (d >= min || d === 0) continue;
        const push = (min - d) / 2;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    }
  }

  /** 周回している甲羅（カード甲羅なら今・次…の順。カスタム甲羅なら手元にある甲羅を投げる順に） */
  private orbitList(a: Actor): { spec: ShellSpec; slot?: number }[] {
    if (a.rot) return a.rot.order().filter((i) => a.ready[i]).map((i) => ({ spec: a.specs[i], slot: i }));
    const h = a.hand;
    let types: ShellType[];
    if (!h) types = [];
    else if (CARD_RULE.pick) types = h.slots.filter((t): t is ShellType => t !== null);
    else types = [...(h.slots[0] ? [h.slots[0]] : []), ...h.upcoming(SHELL.maxStock)];
    return Array.from({ length: a.stock }, (_, i) => ({ spec: SHELLS[types[i] ?? 'normal'] }));
  }

  private orbits(a: Actor) {
    const list = this.orbitList(a);
    return list.map((o, i) => {
      const ang = a.orbitPhase + (i / list.length) * Math.PI * 2;
      return { x: a.x + Math.cos(ang) * SHELL.orbitRadius, y: a.y + Math.sin(ang) * SHELL.orbitRadius, spec: o.spec, slot: o.slot };
    });
  }

  /** 周回甲羅が1個割れる。カスタム甲羅はその甲羅が補充待ちに、それ以外は手持ちが1個減る */
  private loseOrbit(a: Actor, o: { x: number; y: number; spec: ShellSpec; slot?: number }) {
    if (o.slot !== undefined) {
      a.ready[o.slot] = false;
      a.slotRefill[o.slot] = SHELL.refillTime;
      a.stock = a.ready.filter(Boolean).length;
    } else {
      a.stock = Math.max(0, a.stock - 1);
    }
    this.burst(o.x, o.y, 8, o.spec.color, 160, 0.3, 2.5);
  }

  /** 周回甲羅と相手の体、周回甲羅同士の当たり判定 */
  private updateOrbitContacts() {
    const live = this.actors.filter((a) => a.alive);
    for (const a of live) {
      for (const o of this.orbits(a)) {
        for (const b of live) {
          if (b === a || b.inv > 0 || a.stock <= 0) continue;
          if (Math.hypot(b.x - o.x, b.y - o.y) < SHELL.hurtRadius + o.spec.radius) {
            this.loseOrbit(a, o);
            this.damage(b, b.x - a.x, b.y - a.y, o.spec, a);
            break;
          }
        }
      }
    }
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        outer: for (const oa of this.orbits(a)) {
          for (const ob of this.orbits(b)) {
            if (Math.hypot(oa.x - ob.x, oa.y - ob.y) < oa.spec.radius + ob.spec.radius) {
              this.loseOrbit(a, oa);
              this.loseOrbit(b, ob);
              break outer;
            }
          }
        }
      }
    }
  }

  private throwShell(a: Actor, spec: ShellSpec) {
    const off = SHELL.actorRadius + spec.radius + 2;
    const ways = spec.ways ?? 1;
    const family = ++this.throwSeq;
    for (let w = 0; w < ways; w++) {
      const ang = a.aim + (w - (ways - 1) / 2) * (spec.spread ?? 0);
      const s: Shell = {
        x: a.x + Math.cos(ang) * off,
        y: a.y + Math.sin(ang) * off,
        vx: Math.cos(ang) * spec.speed,
        vy: Math.sin(ang) * spec.speed,
        spec,
        owner: a,
        age: 0,
        bounces: 0,
        family,
        trail: [],
        speed: spec.speed,
        pierceLeft: spec.pierce ?? 0,
        reboundLeft: spec.rebound ?? 0,
        recoil: 0,
        homingOff: false,
        passed: new Set(),
        dead: false,
      };
      // 壁際で投げたとき、出現位置が壁や柱にめり込まないようにする
      resolveCircle(s, spec.radius);
      this.shells.push(s);
      this.burst(s.x, s.y, 4, a.color, 120, 0.15, 2);
    }
    a.cooldown = SHELL.throwCooldown;
    if (a.bot) a.ai.throwTimer = SHELL.botThrowInterval[0] + Math.random() * (SHELL.botThrowInterval[1] - SHELL.botThrowInterval[0]);
  }

  /** 甲羅 s が other とぶつかっても割れないか。貫通は回数を使い、通り抜けた相手を覚える */
  private survives(s: Shell, other: ShellSpec, key: string, ox: number, oy: number) {
    if (s.spec.heavy && !other.heavy) return true;
    if (s.pierceLeft > 0) {
      s.pierceLeft--;
      s.passed.add(key);
      this.burst(s.x, s.y, 5, s.spec.color, 140, 0.2, 2);
      return true;
    }
    if (s.reboundLeft > 0) {
      // 反発：相手の中心から見た向きを法線にして跳ね返る
      s.reboundLeft--;
      const d = Math.hypot(s.x - ox, s.y - oy) || 1;
      const nx = (s.x - ox) / d;
      const ny = (s.y - oy) / d;
      const dot = s.vx * nx + s.vy * ny;
      if (dot < 0) {
        s.vx -= 2 * dot * nx;
        s.vy -= 2 * dot * ny;
      }
      const overlap = s.spec.radius + other.radius - d;
      if (overlap > 0) {
        s.x += nx * overlap;
        s.y += ny * overlap;
      }
      s.recoil = 0.12;
      this.burst(s.x, s.y, 6, 0xffffff, 160, 0.2, 2);
      this.onReflect(s, 1);
      return true;
    }
    return false;
  }

  /** 壁・柱・甲羅で b 回反射した：分裂・加速・反射回数の上限 */
  private onReflect(s: Shell, b: number) {
    if (b <= 0 || s.dead) return;
    if (s.bounces < (s.spec.splits ?? (s.spec.split ? 1 : 0))) this.spawnQueue.push(...this.splitShell(s));
    if (s.spec.accel) {
      s.speed = Math.min(s.spec.speed * 2, s.speed * s.spec.accel ** b);
      const sp = Math.hypot(s.vx, s.vy) || 1;
      s.vx = (s.vx / sp) * s.speed;
      s.vy = (s.vy / sp) * s.speed;
    }
    s.bounces += b;
    if (s.bounces > s.spec.bounces) this.breakShell(s);
  }

  /** CPU の判断：狙う相手を決め、距離を保って横移動し、迫る甲羅を避け、当たる角度が見つかれば投げる */
  private think(a: Actor, dt: number) {
    a.ai.throwTimer -= dt;
    a.ai.think -= dt;
    if (a.ai.think > 0) return;
    a.ai.think = 0.12 + Math.random() * 0.1;

    const foes = this.actors.filter((o) => o !== a && o.alive);
    if (foes.length === 0) {
      a.ai.moveX = a.ai.moveY = 0;
      return;
    }
    const target = foes.reduce((best, o) => (Math.hypot(o.x - a.x, o.y - a.y) < Math.hypot(best.x - a.x, best.y - a.y) ? o : best));

    // 移動：適度な距離で横に回り込む
    const dx = target.x - a.x;
    const dy = target.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    if (Math.random() < 0.04) a.ai.strafe *= -1;
    let mx = (-dy / d) * a.ai.strafe;
    let my = (dx / d) * a.ai.strafe;
    if (d < 220) {
      mx -= dx / d;
      my -= dy / d;
    } else if (d > 420) {
      mx += dx / d;
      my += dy / d;
    }

    // 回避：0.7秒先までに自分の近くを通る甲羅があれば、その進路から横に逃げる
    for (const s of this.shells) {
      if (s.dead || (s.owner === a && s.age < SHELL.ownerGrace)) continue;
      const sim = { x: s.x, y: s.y, vx: s.vx, vy: s.vy };
      let close = Infinity;
      let cx = 0;
      let cy = 0;
      let cvx = 0;
      let cvy = 0;
      moveShell(sim, s.spec.radius, s.speed * 0.7, () => {
        const dd = Math.hypot(sim.x - a.x, sim.y - a.y);
        if (dd < close) {
          close = dd;
          cx = sim.x;
          cy = sim.y;
          cvx = sim.vx;
          cvy = sim.vy;
        }
        return false;
      });
      if (close < SHELL.actorRadius + s.spec.radius + 22) {
        const sp = Math.hypot(cvx, cvy) || 1;
        let px = -cvy / sp;
        let py = cvx / sp;
        if ((a.x - cx) * px + (a.y - cy) * py < 0) {
          px = -px;
          py = -py;
        }
        mx = px * 2;
        my = py * 2;
        break;
      }
    }
    a.ai.moveX = mx;
    a.ai.moveY = my;

    // 照準と甲羅選び
    if (a.ai.throwTimer <= 0 && a.cooldown <= 0 && a.stock > 0) {
      const shot = this.findShot(a, target, this.currentSpec(a)?.radius ?? SHELLS.normal.radius);
      if (a.hand) a.ai.pick = CARD_RULE.pick ? this.pickCard(a.hand, shot) : 0;
      if (shot) {
        a.aim = shot.angle + (Math.random() - 0.5) * 0.12;
      } else if (this.currentSpec(a)?.homingTurn) {
        // 当たる角度がなくても、追尾甲羅なら相手の方へ投げておく
        a.aim = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.6;
      } else {
        a.ai.throwTimer = 0.25;
      }
    } else {
      a.aim = Math.atan2(dy, dx);
    }
  }

  /** 直接狙えるなら速い・重い甲羅、反射が必要なら跳ね・分裂、狙えないなら追尾を優先する */
  private pickCard(h: Hand, shot: { angle: number; bounces: number } | null): number {
    const prefs: ShellType[] = !shot
      ? ['homing', 'bouncy', 'split']
      : shot.bounces === 0
        ? ['heavy', 'normal', 'split']
        : ['split', 'bouncy', 'normal', 'homing'];
    for (const p of prefs) {
      const i = h.slots.indexOf(p);
      if (i >= 0) return i;
    }
    const any = h.slots.findIndex((t) => t !== null);
    return any >= 0 ? any : 0;
  }

  /** 角度を総当たりで試し、一番早く target に届く角度を返す。自分に跳ね返ってくる角度は避ける */
  private findShot(a: Actor, target: Actor, radius: number): { angle: number; bounces: number } | null {
    const hitR = SHELL.hurtRadius + radius;
    const direct = Math.atan2(target.y - a.y, target.x - a.x);
    let best: { angle: number; bounces: number } | null = null;
    let bestLen = Infinity;
    const N = 96;
    for (let i = 0; i <= N; i++) {
      const ang = i === N ? direct : (i / N) * Math.PI * 2;
      const off = SHELL.actorRadius + radius + 2;
      const sim = { x: a.x + Math.cos(ang) * off, y: a.y + Math.sin(ang) * off, vx: Math.cos(ang), vy: Math.sin(ang) };
      let travelled = 0;
      let bounces = 0;
      let result: 'hit' | 'self' | null = null;
      for (; travelled < 900 && result === null; travelled += 5) {
        bounces += moveShell(sim, radius, 5);
        if (Math.hypot(sim.x - target.x, sim.y - target.y) < hitR) result = 'hit';
        else if (travelled > 400 * SHELL.ownerGrace && Math.hypot(sim.x - a.x, sim.y - a.y) < hitR + 10) result = 'self';
      }
      if (result === 'hit' && travelled < bestLen) {
        bestLen = travelled;
        best = { angle: ang, bounces };
      }
    }
    return best;
  }

  // ---------------- 甲羅 ----------------

  private updateShells(dt: number) {
    for (const s of this.shells) {
      if (s.dead) continue;
      s.age += dt;
      s.recoil = Math.max(0, s.recoil - dt);
      if (s.age > s.spec.life) {
        this.breakShell(s);
        continue;
      }
      s.trail.push({ x: s.x, y: s.y });
      if (s.trail.length > TRAIL_LENGTH) s.trail.shift();
      if (s.spec.homingTurn && !s.homingOff) this.steerHoming(s, dt);
      const hitR = SHELL.hurtRadius + s.spec.radius;
      const pvx = s.vx;
      const pvy = s.vy;
      const b = moveShell(s, s.spec.radius, s.speed * dt, () => {
        // 周回甲羅が盾になる。投げた直後は自分の周回甲羅を通り抜ける
        for (const a of this.actors) {
          if (!a.alive || (a === s.owner && s.age < SHELL.ownerGrace)) continue;
          if (s.passed.has(`o${a.id}`) || s.recoil > 0) continue;
          for (const o of this.orbits(a)) {
            if (Math.hypot(o.x - s.x, o.y - s.y) < o.spec.radius + s.spec.radius) {
              // 周回しているのが重甲羅なら周回側は残る
              if (!(o.spec.heavy && !s.spec.heavy)) this.loseOrbit(a, o);
              if (!this.survives(s, o.spec, `o${a.id}`, o.x, o.y)) {
                this.breakShell(s);
                return true;
              }
              break;
            }
          }
        }
        for (const a of this.actors) {
          if (!a.alive || a.inv > 0) continue;
          if (a === s.owner && s.age < SHELL.ownerGrace) continue;
          if (Math.hypot(a.x - s.x, a.y - s.y) < hitR) {
            this.hitActor(a, s);
            return true;
          }
        }
        return false;
      });
      if (b > 0 && !s.dead) this.addGlint(s, pvx, pvy);
      this.onReflect(s, b);
    }

    // 甲羅同士：基本は相殺。重甲羅は相手だけ割り、貫通は割れずに抜け、反発は割れずに跳ね返る
    const live = this.shells.filter((s) => !s.dead);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        if (a.dead || b.dead || a.family === b.family) continue;
        if (a.passed.has(`f${b.family}`) || b.passed.has(`f${a.family}`) || a.recoil > 0 || b.recoil > 0) continue;
        const rr = a.spec.radius + b.spec.radius;
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 >= rr * rr) continue;
        const ax = a.x;
        const ay = a.y;
        const aLives = this.survives(a, b.spec, `f${b.family}`, b.x, b.y);
        const bLives = this.survives(b, a.spec, `f${a.family}`, ax, ay);
        if (!aLives) this.breakShell(a);
        if (!bLives) this.breakShell(b);
      }
    }
    this.shells.push(...this.spawnQueue);
    this.spawnQueue = [];
    this.shells = this.shells.filter((s) => !s.dead);
  }

  private steerHoming(s: Shell, dt: number) {
    let best: Actor | null = null;
    let bestD = Infinity;
    for (const a of this.actors) {
      if (!a.alive || a === s.owner) continue;
      const d = Math.hypot(a.x - s.x, a.y - s.y);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    s.target = best ?? undefined;
    if (!best) return;
    // 近づいたら追尾をやめる。最後の瞬間に横へ動けば避けられるように
    if (bestD < SHELL.homingStopDistance) {
      s.homingOff = true;
      s.target = undefined;
      return;
    }
    const cur = Math.atan2(s.vy, s.vx);
    const diff = wrapAngle(Math.atan2(best.y - s.y, best.x - s.x) - cur);
    const turn = s.spec.homingTurn! * dt;
    const ang = cur + Math.max(-turn, Math.min(turn, diff));
    s.vx = Math.cos(ang) * s.speed;
    s.vy = Math.sin(ang) * s.speed;
  }

  /** 分裂：親は普通に反射したまま進み（ガイドどおり）、反射方向の左右に子を1つずつ飛ばす */
  private splitShell(s: Shell): Shell[] {
    const a = Math.atan2(s.vy, s.vx);
    this.burst(s.x, s.y, 10, SPLIT_CHILD.color, 200, 0.3, 2.5);
    this.rings.push({ x: s.x, y: s.y, life: 0.3, color: SPLIT_CHILD.color });
    return [a - SPLIT_ANGLE, a + SPLIT_ANGLE].map((ang) => ({
      x: s.x,
      y: s.y,
      vx: Math.cos(ang) * SPLIT_CHILD.speed,
      vy: Math.sin(ang) * SPLIT_CHILD.speed,
      spec: SPLIT_CHILD,
      owner: s.owner,
      age: Math.max(s.age, SHELL.ownerGrace),
      bounces: 0,
      family: s.family,
      trail: [],
      speed: SPLIT_CHILD.speed,
      pierceLeft: 0,
      reboundLeft: 0,
      recoil: 0,
      homingOff: true,
      passed: new Set(s.passed),
      dead: false,
    }));
  }

  private breakShell(s: Shell) {
    s.dead = true;
    this.burst(s.x, s.y, 8, s.spec.color, 160, 0.3, 2.5);
  }

  private hitActor(a: Actor, s: Shell) {
    s.dead = true;
    this.damage(a, s.vx, s.vy, s.spec, s.owner);
  }

  /** dx, dy はノックバック方向（正規化不要） */
  /** by は当てた人（リプレイで一緒に映す） */
  private damage(a: Actor, dx: number, dy: number, spec: ShellSpec, by?: Actor) {
    if (!a.bot && this.debug.invincible) return;
    a.hp -= 1;
    a.inv = SHELL.invincible;
    const sp = Math.hypot(dx, dy) || 1;
    const kb = SHELL.knockback * (spec.heavy ? 1.6 : 1);
    a.kx += (dx / sp) * kb;
    a.ky += (dy / sp) * kb;
    this.burst(a.x, a.y, 14, spec.color, 260, 0.4, 3);
    // 割れたハートが頭上から飛び散る
    this.burst(a.x, a.y - SHELL.actorRadius - 10, 6, 0xff6b81, 160, 0.5, 2.5);
    this.hitstop = Math.max(this.hitstop, a.bot ? 0.05 : 0.11);
    if (!a.bot) {
      this.cameras.main.shake(180, 0.012);
      this.flashScreen();
    }
    if (a.hp <= 0) {
      a.alive = false;
      this.deadOrder.push(a);
      this.lastKill = { x: a.x, y: a.y, idx: this.recBase + this.rec.length, victim: a.id, killer: (by ?? a).id };
      // 自分がやられたら、やられた場面をリプレイで見せる（決着した場合は checkRoundEnd 側でまとめる）
      if (!a.bot) this.pendingReplay = { t: 0.4, kill: this.lastKill, then: 'live' };
      // 脱落：キャラが砕ける
      this.burst(a.x, a.y, 36, a.color, 380, 0.8, 4);
      this.burst(a.x, a.y, 14, 0xffffff, 220, 0.4, 2);
      this.rings.push({ x: a.x, y: a.y, life: 0.3, color: a.color });
      this.hitstop = Math.max(this.hitstop, 0.14);
      this.cameras.main.shake(200, 0.008);
    }
  }

  /** 自分が被弾したとき、画面の縁を赤く光らせる */
  private flashScreen() {
    const el = $('hit-flash');
    el.classList.remove('on');
    void el.offsetWidth; // アニメーションをやり直す
    el.classList.add('on');
  }

  /** 壁・柱で跳ねた：反射前後の速度の差が法線、その垂直方向に光を走らせる */
  private addGlint(s: Shell, pvx: number, pvy: number) {
    const nx = s.vx - pvx;
    const ny = s.vy - pvy;
    const nl = Math.hypot(nx, ny) || 1;
    this.glints.push({ x: s.x - (nx / nl) * s.spec.radius, y: s.y - (ny / nl) * s.spec.radius, tx: -ny / nl, ty: nx / nl, life: 0.28, color: s.spec.color });
  }

  private checkRoundEnd() {
    const alive = this.actors.filter((a) => a.alive);
    if (alive.length > 1) return;
    this.state = 'result';
    const w = alive[0];
    if (w) w.wins++;
    this.roundWinner = w ?? null;
    this.matchOver = this.drafting && !!w && w.wins >= MATCH.winTarget;
    // 最後の脱落をリプレイしてから、勝者に寄って結果を出す。
    // 自分のリプレイを見ている途中なら、それが終わったら勝者へ
    if (this.replay) this.replay.then = 'winner';
    else if (this.pendingReplay) this.pendingReplay.then = 'winner';
    else if (this.lastKill) this.pendingReplay = { t: 0.45, kill: this.lastKill, then: 'winner' };
    else this.focusWinner();
  }

  /** 勝者に寄ってスローモーション。少し待って結果を出す */
  private focusWinner() {
    const w = this.roundWinner;
    const cam = this.cameras.main;
    cam.setZoom(1);
    cam.centerOn(ARENA.width / 2, ARENA.height / 2);
    this.winnerFocus = 0.8;
    if (w) {
      cam.pan(w.x, w.y, 450, 'Sine.easeOut');
      cam.zoomTo(1.6, 450, 'Sine.easeOut');
    }
  }

  // ---------------- リプレイ ----------------

  /** 今の状態を1コマ録画する */
  private record() {
    this.rec.push(this.capture());
    if (this.rec.length > REPLAY.bufferFrames) {
      this.rec.shift();
      this.recBase++;
    }
  }

  private startReplay(kill: Kill, then: 'live' | 'winner') {
    const from = Math.max(0, kill.idx - REPLAY.before - this.recBase);
    const to = Math.min(this.rec.length, kill.idx + REPLAY.after - this.recBase);
    const frames = this.rec.slice(from, to);
    if (frames.length < 10) {
      if (then === 'winner') this.focusWinner();
      return;
    }
    this.replay = { frames, pos: 0, then, kill };
    this.replayCam = { x: ARENA.width / 2, y: ARENA.height / 2, zoom: 1 };
    this.aimReplayCamera(1);
    $('replay').hidden = false;
  }

  /**
   * リプレイのカメラ：やられた側と当てた側の両方が入るように中心と拡大率を決め、ease の割合で寄せる。
   * やられた側は脱落後は脱落した場所を使う。自分の甲羅で自滅したときは1人だけを映す
   */
  private aimReplayCamera(ease: number) {
    const r = this.replay!;
    const f = r.frames[Math.min(r.frames.length - 1, Math.floor(r.pos))];
    const v = f.actors[r.kill.victim];
    const vx = v.alive ? v.x : r.kill.x;
    const vy = v.alive ? v.y : r.kill.y;
    const k = f.actors[r.kill.killer];
    const both = r.kill.killer !== r.kill.victim && k.alive;
    const kx = both ? k.x : vx;
    const ky = both ? k.y : vy;
    const cx = (vx + kx) / 2;
    const cy = (vy + ky) / 2;
    // 2人の間の距離に余白を足した範囲が画面に収まる拡大率。再生が進むほど少しずつ寄る
    const fit = Math.min(ARENA.width / (Math.abs(vx - kx) + 320), ARENA.height / (Math.abs(vy - ky) + 240));
    const push = 1 + 0.15 * Math.min(1, r.pos / r.frames.length);
    const zoom = Math.max(REPLAY.zoomMin, Math.min(REPLAY.zoomMax, fit * push));
    // カメラ位置は自前で持って寄せる（試合場の外が映らない範囲に収める）
    const c = this.replayCam;
    c.zoom += (zoom - c.zoom) * ease;
    c.x += (cx - c.x) * ease;
    c.y += (cy - c.y) * ease;
    const hw = ARENA.width / (2 * c.zoom);
    const hh = ARENA.height / (2 * c.zoom);
    c.x = Math.max(hw, Math.min(ARENA.width - hw, c.x));
    c.y = Math.max(hh, Math.min(ARENA.height - hh, c.y));
    const cam = this.cameras.main;
    cam.setZoom(c.zoom);
    cam.centerOn(c.x, c.y);
  }

  private replayCam = { x: 0, y: 0, zoom: 1 };

  private endReplay() {
    const r = this.replay;
    if (!r) return;
    this.replay = null;
    $('replay').hidden = true;
    const cam = this.cameras.main;
    cam.setZoom(1);
    cam.centerOn(ARENA.width / 2, ARENA.height / 2);
    if (r.then === 'winner') this.focusWinner();
  }

  private roundWinner: Actor | null = null;

  private showResult() {
    const w = this.roundWinner;
    $('shell-result-tag').textContent = this.matchOver ? 'CHAMPION' : `ROUND ${this.round}`;
    const title = $('shell-winner');
    title.textContent = !w ? '引き分け' : this.matchOver ? `${w.bot ? w.name : 'あなた'} が優勝！` : w.bot ? `${w.name} の勝ち` : 'あなたの勝ち！';
    title.style.color = w ? hex(w.color) : '';
    $('shell-result-stars').innerHTML = w && this.drafting ? this.starsHtml(w.wins, true) : '';
    // 優勝したら最終ビルドを見せる
    $('shell-result-build').innerHTML =
      w && this.matchOver ? `<div class="rb-label">優勝したビルド</div><div class="rb-shells">${this.buildCards(w)}</div>` : '';
    $('shell-next').textContent = !this.drafting ? '次のラウンド（R）' : this.matchOver ? '新しい試合（R）' : this.custom ? '効果を選ぶ（R）' : 'カードを選ぶ（R）';
    $('shell-result').hidden = false;
    this.confetti = this.matchOver ? 4 : 0;
  }

  private confetti = 0;

  /** 星：先に MATCH.winTarget 勝。pop を付けると最後に増えた星を弾ませる */
  private starsHtml(wins: number, pop = false) {
    return Array.from({ length: MATCH.winTarget }, (_, i) => `<i class="star${i < wins ? ' on' : ''}${pop && i === wins - 1 ? ' pop' : ''}">★</i>`).join('');
  }

  /** 甲羅（カスタム甲羅）かデッキ（カード甲羅）の性能一覧 */
  private buildSpecs(a: Actor): ShellSpec[] {
    if (this.custom) return a.loadout.map((lv, i) => buildSpec(lv, i));
    if (this.cards) return a.deck.map((t) => SHELLS[t]);
    return [];
  }

  /** 効果のバッジ（カスタム甲羅） */
  private badges(lv: ShellLevels) {
    const list = EFFECT_IDS.filter((e) => lv[e] > 0);
    if (list.length === 0) return '<span class="badge plain">強化なし</span>';
    return list.map((e) => `<span class="badge" style="--c:${hex(EFFECTS[e].color)}">${EFFECTS[e].name}${lv[e]}</span>`).join('');
  }

  /** 結果やドラフトで使う、甲羅ごとのカード */
  private buildCards(a: Actor) {
    if (this.custom)
      return a.loadout
        .map((lv, i) => {
          const sp = buildSpec(lv, i);
          return `<div class="bcard" style="--c:${hex(sp.color)}">${shellSvg(sp, 40)}<strong>${sp.name}</strong><div class="badges">${this.badges(lv)}</div></div>`;
        })
        .join('');
    return this.buildSpecs(a)
      .map((sp) => `<div class="bcard small" style="--c:${hex(sp.color)}">${shellSvg(sp, 28)}<span>${sp.name}</span></div>`)
      .join('');
  }

  /** 結果画面の次へ：甲羅バトルはすぐ次のラウンド、それ以外はドラフトか新しい試合 */
  private proceed() {
    if (!this.drafting) return this.newRound();
    $('shell-result').hidden = true;
    if (this.matchOver) {
      this.matchOver = false;
      this.round = 0;
      for (const a of this.actors) {
        a.wins = 0;
        a.deck = [...STARTER_DECK];
        a.loadout = starterLoadout();
      }
      return this.newRound();
    }
    const ids: string[] = this.custom ? effectCandidates(this.actors.length) : draftCandidates(this.actors.length);
    this.draft = ids.map((id) => ({ id, takenBy: null }));
    // 脱落した順、最後まで残った人（勝者）が最後
    this.draftOrder = [...this.deadOrder, ...this.actors.filter((a) => !this.deadOrder.includes(a))];
    this.draftTurn = 0;
    this.draftSel = null;
    this.draftLog = [];
    this.lastTaken = -1;
    this.state = 'draft';
    $('draft').hidden = false;
    this.advanceDraft();
  }

  // ---------------- ドラフト ----------------
  // カード甲羅：候補は甲羅の種類。取った候補をデッキの1枚と入れ替える
  // カスタム甲羅：候補は効果。取った効果を甲羅1〜3のどれかに付ける（同じ効果ならレベルが上がる）

  private draft: { id: string; takenBy: Actor | null }[] = [];
  private draftOrder: Actor[] = [];
  private draftTurn = 0;
  private draftSel: number | null = null;
  private draftLog: string[] = [];
  /** このラウンドで脱落した順 */
  private deadOrder: Actor[] = [];

  private candidateInfo(id: string): { name: string; desc: string; color: number } {
    return this.custom ? EFFECTS[id as EffectId] : SHELLS[id as ShellType];
  }

  /** 候補を当てはめる先（カード甲羅はデッキのカード、カスタム甲羅は甲羅1〜3） */
  private targets(a: Actor): { label: string; color: number }[] {
    if (this.custom) return a.loadout.map((lv, i) => ({ label: `甲羅${i + 1}：${summary(lv)}`, color: buildSpec(lv, i).color }));
    return a.deck.map((t) => ({ label: SHELLS[t].name, color: SHELLS[t].color }));
  }

  /** 自分の番まで CPU に選ばせる。全員終わったら次のラウンドへ */
  private advanceDraft() {
    if (this.draftTurn >= this.draftOrder.length) {
      // 全員選び終えた。最後の選択を少し見せてから次のラウンドへ
      this.draftBusy = true;
      this.renderDraft();
      this.time.delayedCall(700, () => {
        if (this.state !== 'draft') return;
        this.draftBusy = false;
        $('draft').hidden = true;
        this.newRound();
      });
      return;
    }
    const a = this.draftOrder[this.draftTurn];
    if (a.bot) {
      // CPU は少し間を置いて1人ずつ選ぶ（何を取ったか目で追えるように）
      this.draftBusy = true;
      this.renderDraft();
      this.time.delayedCall(550, () => {
        if (this.state !== 'draft') return;
        this.botDraft(a);
        this.draftTurn++;
        this.draftBusy = false;
        this.advanceDraft();
      });
      return;
    }
    this.renderDraft();
  }

  /** CPU の選択を見せている間は、自分の操作を受け付けない */
  private draftBusy = false;
  /** 直前に取られた候補（取られる演出を付ける） */
  private lastTaken = -1;

  /** 候補 ci を取り、ti 番目に当てはめる。ci が null なら何もしない */
  private applyCandidate(a: Actor, ci: number | null, ti = 0) {
    if (ci === null) {
      this.draftLog.push(`${a.name}：${this.custom ? '付けない' : '交換しない'}`);
      return;
    }
    const c = this.draft[ci];
    c.takenBy = a;
    this.lastTaken = ci;
    if (this.custom) {
      const lv = a.loadout[ti];
      lv[c.id as EffectId]++;
      this.draftLog.push(`${a.name}：甲羅${ti + 1} に${EFFECTS[c.id as EffectId].name}（${summary(lv)}）`);
    } else {
      const out = a.deck[ti];
      a.deck[ti] = c.id as ShellType;
      this.draftLog.push(`${a.name}：${SHELLS[out].name} → ${SHELLS[c.id as ShellType].name}`);
    }
  }

  /** 1〜4 キーか候補のクリック：取る候補を選ぶ（もう一度押すと取り消し） */
  private draftSelect(i: number) {
    if (this.state !== 'draft' || this.draftBusy || !this.draft[i] || this.draft[i].takenBy) return;
    this.draftSel = this.draftSel === i ? null : i;
    this.renderDraft();
  }

  /** 当てはめ先のクリック */
  private draftApply(ti: number) {
    if (this.state !== 'draft' || this.draftBusy || this.draftSel === null) return;
    this.applyCandidate(this.actors[0], this.draftSel, ti);
    this.draftSel = null;
    this.draftTurn++;
    this.advanceDraft();
  }

  private draftPass() {
    if (this.state !== 'draft' || this.draftBusy) return;
    this.applyCandidate(this.actors[0], null);
    this.draftSel = null;
    this.draftTurn++;
    this.advanceDraft();
  }

  private botDraft(a: Actor) {
    const free = this.draft.map((c, i) => (c.takenBy ? -1 : i)).filter((i) => i >= 0);
    if (free.length === 0) return this.applyCandidate(a, null);
    const ci = free[Math.floor(Math.random() * free.length)];
    if (this.custom) {
      // 半分は同じ効果を持つ甲羅に重ね、残りはランダムな甲羅に付ける
      const eff = this.draft[ci].id as EffectId;
      const has = a.loadout.map((lv, i) => (lv[eff] > 0 ? i : -1)).filter((i) => i >= 0);
      const ti = has.length && Math.random() < 0.5 ? has[0] : Math.floor(Math.random() * SHELL_COUNT);
      return this.applyCandidate(a, ci, ti);
    }
    // カード甲羅：緑甲羅があれば入れ替える。なければ半々で、交換しないか一番多い種類と入れ替える
    const normal = a.deck.indexOf('normal');
    if (normal >= 0) return this.applyCandidate(a, ci, normal);
    if (Math.random() < 0.5) return this.applyCandidate(a, null);
    const count = (t: ShellType) => a.deck.filter((x) => x === t).length;
    const most = a.deck.reduce((best, t, i) => (count(t) > count(a.deck[best]) ? i : best), 0);
    this.applyCandidate(a, ci, most);
  }

  private renderDraft() {
    const me = this.actors[0];
    $('draft').querySelector('h2')!.textContent = this.custom ? '効果を付ける' : 'カードを交換';
    $('draft-sub').textContent = `ラウンド${this.round}終了 ・ 先に${MATCH.winTarget}勝で優勝`;
    const turnActor = this.draftOrder[this.draftTurn];
    $('draft-order').innerHTML =
      this.draftOrder
        .map((a, i) => {
          const cls = i === this.draftTurn ? 'now' : i < this.draftTurn ? 'done' : '';
          return `<span class="ord ${cls}" style="--c:${hex(a.color)}">${a.name}</span>`;
        })
        .join('<span class="arrow">→</span>') +
      `<div class="turn">${!turnActor ? '全員選び終えた' : turnActor.bot ? `${turnActor.name} が選んでいます…` : 'あなたの番'}</div>`;
    $('draft-log').innerHTML = this.draftLog.map((l) => `<li>${l}</li>`).join('');

    const box = $('draft-choices');
    box.innerHTML = '';
    this.draft.forEach((c, i) => {
      const info = this.candidateInfo(c.id);
      const icon = this.custom ? shellSvg(this.effectPreviewSpec(c.id as EffectId), 44) : shellSvg(SHELLS[c.id as ShellType], 44);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `choice dchoice${this.draftSel === i ? ' picked' : ''}${c.takenBy && i === this.lastTaken ? ' just-taken' : ''}`;
      btn.disabled = !!c.takenBy || this.draftBusy;
      btn.style.setProperty('--c', hex(info.color));
      const taken = c.takenBy ? `<span class="taken" style="--c:${hex(c.takenBy.color)}">${c.takenBy.name} が取った</span>` : '';
      btn.innerHTML = `<span class="key">${i + 1}</span><div class="dc-ico">${icon}</div><strong>${info.name}</strong><span class="desc">${info.desc}</span>${taken}`;
      btn.onclick = () => this.draftSelect(i);
      box.appendChild(btn);
    });

    const selName = this.draftSel === null ? '' : this.candidateInfo(this.draft[this.draftSel].id).name;
    $('draft-deck-title').textContent = this.custom
      ? this.draftSel === null
        ? 'あなたの甲羅（効果を選ぶと、付ける甲羅を選べる）'
        : `${selName} を付ける甲羅を選ぶ`
      : this.draftSel === null
        ? 'あなたのデッキ（候補を選ぶと、入れ替えるカードを選べる）'
        : `${selName} と入れ替えるカードを選ぶ`;
    const deck = $('draft-deck');
    deck.innerHTML = '';
    const specs = this.buildSpecs(me);
    specs.forEach((sp, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `deckcard tcard${this.draftSel !== null ? ' armed' : ''}`;
      btn.disabled = this.draftSel === null || this.draftBusy;
      btn.style.setProperty('--c', hex(sp.color));
      let body = `${shellSvg(sp, this.custom ? 36 : 26)}<span class="tc-name">${sp.name}</span>`;
      if (this.custom) {
        body += `<div class="badges">${this.badges(me.loadout[i])}</div>`;
        if (this.draftSel !== null) {
          // 付けた後の姿を先に見せる
          const after = { ...me.loadout[i] };
          after[this.draft[this.draftSel].id as EffectId]++;
          body += `<div class="tc-after">→ ${summary(after)}</div>`;
        }
      }
      btn.innerHTML = body;
      btn.onclick = () => this.draftApply(i);
      deck.appendChild(btn);
    });
    const pass = $('draft-pass') as HTMLButtonElement;
    pass.textContent = this.custom ? '付けない（N）' : '交換しない（N）';
    pass.disabled = this.draftBusy;
    pass.onclick = () => this.draftPass();
  }

  /** ドラフトの候補アイコン用：その効果だけを Lv1 で付けた甲羅 */
  private effectPreviewSpec(e: EffectId): ShellSpec {
    const lv = emptyLevels();
    lv[e] = 1;
    return { ...buildSpec(lv, 0), color: EFFECTS[e].color };
  }

  // ---------------- 演出・描画 ----------------

  private burst(x: number, y: number, n: number, color: number, speed: number, life: number, r: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, r, color });
    }
  }

  private updateParticles(dt: number) {
    const damp = Math.exp(-5 * dt);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= damp;
      p.vy *= damp;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const gl of this.glints) gl.life -= dt;
    this.glints = this.glints.filter((gl) => gl.life > 0);
  }

  /** 左上のプレイヤーカード。毎回作り直すとアニメーションが途切れるので、一度作って中身だけ更新する */
  private hudBuilt = false;
  private hudCache = new Map<number, { hp: number; wins: number; alive: boolean; icons: string }>();

  private renderHud() {
    if (this.actors.length === 0) return;
    const el = $('shell-hud');
    if (!this.hudBuilt) {
      el.innerHTML =
        '<div class="hud-round"></div>' +
        this.actors
          .map(
            (a) =>
              `<div class="pcard${a.bot ? '' : ' me'}" data-id="${a.id}" style="--c:${hex(a.color)}"><div class="pc-top"><span class="pc-name">${a.name}</span><span class="pc-stars"></span></div><div class="pc-bottom"><span class="pc-hp"></span><span class="pc-shells"></span></div></div>`,
          )
          .join('');
      this.hudBuilt = true;
      this.hudCache.clear();
    }
    el.querySelector('.hud-round')!.innerHTML = `ROUND ${this.round}${this.drafting ? `<span>先に${MATCH.winTarget}勝</span>` : ''}`;
    for (const a of this.actors) {
      const card = el.querySelector<HTMLElement>(`.pcard[data-id="${a.id}"]`)!;
      const prev = this.hudCache.get(a.id);
      if (!prev || prev.hp !== a.hp) {
        const lost = prev && a.hp < prev.hp ? prev.hp : -1;
        card.querySelector('.pc-hp')!.innerHTML = Array.from(
          { length: SHELL.hp },
          (_, i) => `<i class="heart${i < a.hp ? ' on' : ''}${lost >= 0 && i >= a.hp && i < lost ? ' break' : ''}">♥</i>`,
        ).join('');
        if (prev && a.hp < prev.hp) {
          card.classList.remove('hit');
          void card.offsetWidth;
          card.classList.add('hit');
        }
      }
      if (!prev || prev.wins !== a.wins) {
        card.querySelector('.pc-stars')!.innerHTML = this.drafting ? this.starsHtml(a.wins, !!prev && a.wins > prev.wins) : `${a.wins}勝`;
      }
      card.classList.toggle('out', !a.alive);
      const icons = this.drafting ? this.buildSpecs(a).map((sp) => shellSvg(sp, this.custom ? 22 : 14)).join('') : '';
      if (!prev || prev.icons !== icons) card.querySelector('.pc-shells')!.innerHTML = icons;
      this.hudCache.set(a.id, { hp: a.hp, wins: a.wins, alive: a.alive, icons });
    }
  }

  /** 画面下の手元の甲羅。並びや中身が変わったときだけ作り直し、補充の進み具合は毎回更新する */
  private handKey = '';

  private renderHand() {
    const el = $('hand');
    const me = this.actors[0];
    if (!me || (!me.hand && !me.rot)) {
      el.hidden = true;
      this.handKey = '';
      return;
    }
    el.hidden = false;
    type Item = { key: string; spec: ShellSpec | null; now: boolean; slot: number; mini: boolean; extra: string };
    let items: Item[];
    if (me.rot) {
      const cur = this.currentSlot(me);
      items = me.rot.order().map((slot) => ({
        key: slot === cur ? '今' : String(slot + 1),
        spec: me.specs[slot],
        now: slot === cur,
        slot,
        mini: false,
        extra: `<div class="badges">${this.badges(me.loadout[slot])}</div>`,
      }));
    } else {
      const h = me.hand!;
      const sp = (t: ShellType | null) => (t ? SHELLS[t] : null);
      if (CARD_RULE.pick) {
        items = h.slots.map((t, i) => ({ key: String(i + 1), spec: sp(t), now: i === h.selected, slot: -1, mini: false, extra: t ? `<span class="hc-desc">${SHELLS[t].desc}</span>` : '' }));
      } else {
        items = [
          { key: '今', spec: sp(h.slots[0]), now: true, slot: -1, mini: false, extra: h.slots[0] ? `<span class="hc-desc">${SHELLS[h.slots[0]].desc}</span>` : '' },
          ...h.upcoming(CARD_RULE.previewCount).map((t, i) => ({ key: i === 0 ? '次' : String(i + 1), spec: SHELLS[t], now: false, slot: -1, mini: true, extra: '' })),
        ];
      }
    }
    const waiting = (it: Item) => it.slot >= 0 && !me.ready[it.slot];
    const key = items.map((it) => `${it.key}:${it.spec?.name}:${it.spec?.desc}:${waiting(it)}`).join('|');
    if (key !== this.handKey) {
      this.handKey = key;
      el.innerHTML = items
        .map((it) => {
          if (!it.spec) return `<div class="hcard wait"><div class="hc-ico"></div><div class="hc-text"><div class="hc-head"><span class="hc-key">${it.key}</span><strong>補充中…</strong></div></div></div>`;
          const cls = `hcard${it.now ? ' now' : ''}${waiting(it) ? ' wait' : ''}${it.mini ? ' mini' : ''}`;
          return `<div class="${cls}" style="--c:${hex(it.spec.color)}"><div class="hc-ico" data-slot="${it.slot}">${shellSvg(it.spec, it.mini ? 24 : 34)}</div><div class="hc-text"><div class="hc-head"><span class="hc-key">${it.key}</span><strong>${it.spec.name}</strong></div>${it.extra}</div></div>`;
        })
        .join('');
    }
    // 補充中の甲羅は、アイコンの周りの輪が時計回りに溜まっていく
    if (me.rot) {
      el.querySelectorAll<HTMLElement>('.hc-ico[data-slot]').forEach((ico) => {
        const slot = Number(ico.dataset.slot);
        const p = me.ready[slot] ? 1 : 1 - me.slotRefill[slot] / SHELL.refillTime;
        ico.style.setProperty('--p', String(Math.max(0, Math.min(1, p))));
      });
    }
  }

  /** ラウンド開始：ROUND N と全員のビルドを見せながら 3・2・1 */
  private introRound = -1;
  private introCount = '';

  private renderIntro() {
    const el = $('round-intro');
    const show = this.state === 'countdown';
    el.hidden = !show;
    if (!show) return;
    if (this.introRound !== this.round) {
      this.introRound = this.round;
      this.introCount = '';
      el.querySelector('.ri-round')!.textContent = `ROUND ${this.round}`;
      el.querySelector('.ri-sub')!.textContent = this.drafting ? `先に${MATCH.winTarget}勝で優勝` : '';
      el.querySelector('.ri-lineup')!.innerHTML = this.drafting
        ? this.actors
            .map(
              (a) =>
                `<div class="ri-p" style="--c:${hex(a.color)}"><div class="ri-name">${a.name}</div><div class="ri-stars">${this.starsHtml(a.wins)}</div><div class="ri-shells">${this.buildSpecs(a)
                  .map((sp) => shellSvg(sp, this.custom ? 30 : 16))
                  .join('')}</div></div>`,
            )
            .join('')
        : '';
    }
    const n = String(Math.max(1, Math.ceil(this.countdown / (SHELL.countdown / 3))));
    if (n !== this.introCount) {
      this.introCount = n;
      const c = el.querySelector<HTMLElement>('.ri-count')!;
      c.textContent = n;
      c.classList.remove('tick');
      void c.offsetWidth;
      c.classList.add('tick');
    }
  }

  /** 周回している手持ちの甲羅。3連は小さな円3つで描く。angle は周回の進む向き */
  private drawOrbitShell(x: number, y: number, spec: ShellSpec, angle: number) {
    const ways = spec.ways ?? 1;
    if (ways <= 1) return drawShell(this.g, x, y, spec.radius, spec, angle, 1);
    const r = spec.radius * 0.7;
    for (let i = 0; i < ways; i++) {
      const a = -Math.PI / 2 + (i / ways) * Math.PI * 2;
      drawShell(this.g, x + Math.cos(a) * spec.radius * 0.85, y + Math.sin(a) * spec.radius * 0.85, r, spec, angle, 1, { multi: false });
    }
  }

  // ---------------- デバッグ ----------------

  /** カスタム甲羅のデバッグウィンドウ：自分の甲羅1〜3に効果を好きなだけ積む。変更はすぐ反映 */
  private renderDebug() {
    const el = $('shell-debug');
    el.hidden = !(this.custom && this.debugOpen);
    if (el.hidden) return;
    const me = this.actors[0];
    const btn = (label: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = () => {
        b.blur(); // Space で押し直されないように
        onClick();
      };
      return b;
    };
    const rebuild = () => {
      me.specs = me.loadout.map((l, i) => buildSpec(l, i));
      this.renderDebug();
      this.renderHand();
    };
    const setLevel = (slot: number, e: EffectId, lv: number) => {
      me.loadout[slot][e] = Math.max(0, lv);
      rebuild();
    };

    el.innerHTML = '<h3>デバッグ（Tab で閉じる）</h3>';
    const table = document.createElement('table');
    const head = document.createElement('tr');
    head.innerHTML = '<th></th>' + me.specs.map((sp, i) => `<th style="color:${hex(sp.color)}">甲羅${i + 1}</th>`).join('');
    table.appendChild(head);
    for (const e of EFFECT_IDS) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = EFFECTS[e].name;
      name.style.color = hex(EFFECTS[e].color);
      tr.appendChild(name);
      for (let slot = 0; slot < SHELL_COUNT; slot++) {
        const td = document.createElement('td');
        const lv = me.loadout[slot][e];
        const num = document.createElement('span');
        num.textContent = String(lv);
        num.className = lv > 0 ? 'lv on' : 'lv';
        td.append(btn('−', () => setLevel(slot, e, lv - 1)), num, btn('＋', () => setLevel(slot, e, lv + 1)));
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    el.appendChild(table);

    const opts = document.createElement('div');
    opts.className = 'dopts';
    for (const [key, label] of [
      ['invincible', '自分は無敵'],
      ['cpuHold', 'CPU が投げない'],
      ['hitbox', '当たり判定を表示'],
    ] as const) {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.debug[key];
      cb.onchange = () => {
        this.debug[key] = cb.checked;
        cb.blur();
      };
      l.append(cb, ` ${label}`);
      opts.appendChild(l);
    }
    opts.appendChild(
      btn('全部リセット', () => {
        me.loadout = starterLoadout();
        rebuild();
      }),
    );
    el.appendChild(opts);
  }

  /** デバッグ：当たり判定の円。赤＝キャラが甲羅に当たる判定、黄＝甲羅（飛んでいるもの・周回しているもの） */
  private drawHitboxes() {
    const g = this.g;
    for (const a of this.actors) {
      if (!a.alive) continue;
      g.lineStyle(1, 0x5a6b8f, 0.8);
      g.strokeCircle(a.x, a.y, SHELL.actorRadius);
      g.lineStyle(2, 0xff3b3b, 1);
      g.strokeCircle(a.x, a.y, SHELL.hurtRadius);
      for (const o of this.orbits(a)) {
        g.lineStyle(1.5, 0xffe14a, 1);
        g.strokeCircle(o.x, o.y, o.spec.radius);
      }
    }
    for (const s of this.shells) {
      g.lineStyle(1.5, 0xffe14a, 1);
      g.strokeCircle(s.x, s.y, s.spec.radius);
    }
  }

  private drawArena() {
    const W = ARENA.width;
    const H = ARENA.height;
    // 床：中央が少し明るい暗い床（キャンバスで作ったグラデーションを貼る）
    const key = 'shell-floor';
    if (!this.textures.exists(key)) {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d')!;
      const grad = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.65);
      grad.addColorStop(0, '#1a2234');
      grad.addColorStop(1, '#070a10');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      // ごく薄い大きなタイル
      ctx.strokeStyle = 'rgba(120, 150, 220, 0.05)';
      ctx.lineWidth = 1;
      for (let x = L; x <= R; x += 160) ctx.strokeRect(x, T, 160, B - T);
      for (let y = T; y <= B; y += 160) ctx.strokeRect(L, y, R - L, 160);
      this.textures.addCanvas(key, c);
    }
    this.add.image(0, 0, key).setOrigin(0).setDepth(0);

    const bg = this.add.graphics().setDepth(1);
    // 柱の影
    bg.fillStyle(0x000000, 0.38);
    for (const p of PILLARS) bg.fillRect(p.x + 8, p.y + 10, p.w, p.h);
    // 外壁
    bg.fillStyle(0x161d2b, 1);
    bg.fillRect(0, 0, W, T);
    bg.fillRect(0, B, W, H - B);
    bg.fillRect(0, 0, L, H);
    bg.fillRect(R, 0, W - R, H);
    // 柱：本体と上面の明るい帯
    for (const p of PILLARS) {
      bg.fillStyle(0x1f2a40, 1);
      bg.fillRect(p.x, p.y, p.w, p.h);
      bg.fillStyle(0x2c3a58, 1);
      bg.fillRect(p.x, p.y, p.w, Math.min(8, p.h / 3));
    }
    // ネオンの縁（加算合成でにじませる）
    const glow = this.add.graphics().setDepth(2).setBlendMode(Phaser.BlendModes.ADD);
    const edge = (w: number, a: number) => {
      glow.lineStyle(w, 0x4f7cff, a);
      glow.strokeRect(L, T, R - L, B - T);
      for (const p of PILLARS) glow.strokeRect(p.x, p.y, p.w, p.h);
    };
    edge(8, 0.06);
    edge(4, 0.12);
    edge(1.5, 0.7);
  }

  /** 今の状態を描画用に写す */
  private capture(): Frame {
    const targeted = new Set(this.shells.filter((s) => !s.dead && s.target && !s.homingOff).map((s) => s.target!));
    return {
      actors: this.actors.map((a) => ({
        x: a.x,
        y: a.y,
        aim: a.aim,
        alive: a.alive,
        inv: a.inv,
        hp: a.hp,
        color: a.color,
        targeted: targeted.has(a),
        orbits: a.alive ? this.orbits(a).map((o) => ({ x: o.x, y: o.y, spec: o.spec, angle: Math.atan2(o.y - a.y, o.x - a.x) + Math.PI / 2 })) : [],
      })),
      shells: this.shells
        .filter((s) => !s.dead)
        .map((s) => ({
          x: s.x,
          y: s.y,
          angle: Math.atan2(s.vy, s.vx),
          spec: s.spec,
          fade: s.age > s.spec.life - 1.5 ? 0.5 + 0.5 * Math.sin(s.age * 30) : 1,
          ownerColor: s.owner.color,
          trail: s.trail.slice(),
          live: {
            split: s.bounces < (s.spec.splits ?? (s.spec.split ? 1 : 0)),
            pierce: s.pierceLeft > 0,
            rebound: s.reboundLeft > 0,
            homing: !!s.spec.homingTurn && !s.homingOff,
          },
        })),
      particles: this.particles.map((p) => ({ x: p.x, y: p.y, r: p.r, color: p.color, a: Math.max(0, p.life / p.max) })),
      glints: this.glints.map((gl) => ({ x: gl.x, y: gl.y, tx: gl.tx, ty: gl.ty, k: gl.life / 0.28, color: gl.color })),
      rings: this.rings.map((r) => ({ x: r.x, y: r.y, k: r.life / 0.3, color: r.color })),
    };
  }

  private render() {
    const g = this.g;
    g.clear();
    this.fx.clear();
    // リプレイ中は録画を、それ以外は今の状態を描く
    const frame = this.replay ? this.replay.frames[Math.min(this.replay.frames.length - 1, Math.floor(this.replay.pos))] : this.capture();
    this.drawFrame(frame);
    if (this.replay) {
      this.label.setText('');
      return;
    }

    const me = this.actors[0];
    if (!me.alive && this.state === 'play') this.label.setText(this.drafting ? (this.fast ? '早送り中（R で戻す）' : '脱落… R で早送り') : '脱落… R で次のラウンド').setFontSize(28);
    else this.label.setText('').setFontSize(48);

    if (this.debug.hitbox) this.drawHitboxes();

    const ptr = this.input.activePointer;
    g.lineStyle(2, 0xffffff, 0.85);
    g.strokeCircle(ptr.worldX, ptr.worldY, 9);
    g.lineBetween(ptr.worldX - 15, ptr.worldY, ptr.worldX - 5, ptr.worldY);
    g.lineBetween(ptr.worldX + 5, ptr.worldY, ptr.worldX + 15, ptr.worldY);
    g.lineBetween(ptr.worldX, ptr.worldY - 15, ptr.worldX, ptr.worldY - 5);
    g.lineBetween(ptr.worldX, ptr.worldY + 5, ptr.worldX, ptr.worldY + 15);
  }

  private drawFrame(f: Frame) {
    const g = this.g;
    const fx = this.fx;

    // 壁で跳ねた光
    for (const gl of f.glints) {
      const len = 10 + (1 - gl.k) * 22;
      fx.lineStyle(3, gl.color, 0.9 * gl.k);
      fx.lineBetween(gl.x - gl.tx * len, gl.y - gl.ty * len, gl.x + gl.tx * len, gl.y + gl.ty * len);
      fx.fillStyle(0xffffff, 0.8 * gl.k);
      fx.fillCircle(gl.x, gl.y, 3 * gl.k + 1);
    }

    // 甲羅：残像と光（加算）→ 本体（模様付き）
    for (const s of f.shells) {
      s.trail.forEach((p, i) => {
        const k = (i + 1) / (s.trail.length + 1);
        fx.fillStyle(s.spec.color, 0.3 * k * s.fade);
        fx.fillCircle(p.x, p.y, s.spec.radius * (0.35 + 0.55 * k));
      });
      fx.fillStyle(s.spec.color, 0.12 * s.fade);
      fx.fillCircle(s.x, s.y, s.spec.radius * 2.2);
      drawShell(g, s.x, s.y, s.spec.radius, s.spec, s.angle, s.fade, s.live);
      // 投げた人の色の小さな点
      g.fillStyle(s.ownerColor, s.fade);
      g.fillCircle(s.x - Math.cos(s.angle) * s.spec.radius * 0.45, s.y - Math.sin(s.angle) * s.spec.radius * 0.45, 2);
    }

    // 追尾の目印：狙われているキャラの周りに回る赤い照準
    const t = performance.now() / 1000;
    for (const a of f.actors) {
      if (!a.alive || !a.targeted) continue;
      const rr = SHELL.actorRadius + 10 + Math.sin(t * 8) * 2;
      g.lineStyle(2, 0xff3b3b, 0.9);
      for (let i = 0; i < 4; i++) {
        const ang = t * 2 + (i * Math.PI) / 2;
        g.beginPath();
        g.arc(a.x, a.y, rr, ang - 0.35, ang + 0.35);
        g.strokePath();
      }
    }

    for (const r of f.rings) {
      fx.lineStyle(3, r.color, r.k);
      fx.strokeCircle(r.x, r.y, 10 + (1 - r.k) * 30);
    }

    // キャラ
    for (const a of f.actors) {
      if (!a.alive) continue;
      // 足元の光
      fx.fillStyle(a.color, 0.1);
      fx.fillCircle(a.x, a.y, SHELL.actorRadius * 2.4);
      // 周回している手持ちの甲羅（無敵中の点滅でも消さない）。3連は小さな円3つ
      for (const o of a.orbits) this.drawOrbitShell(o.x, o.y, o.spec, o.angle);
      const blink = a.inv > 0 && Math.floor(a.inv * 16) % 2 === 0;
      if (blink) continue;
      g.lineStyle(6, a.color, 0.7);
      g.lineBetween(a.x, a.y, a.x + Math.cos(a.aim) * (SHELL.actorRadius + 8), a.y + Math.sin(a.aim) * (SHELL.actorRadius + 8));
      g.fillStyle(shade(a.color, 0.55), 1);
      g.fillCircle(a.x, a.y, SHELL.actorRadius);
      g.fillStyle(a.color, 1);
      g.fillCircle(a.x, a.y, SHELL.actorRadius - 2.5);
      g.fillStyle(0x0a0d13, 0.6);
      g.fillCircle(a.x, a.y, SHELL.actorRadius * 0.4);
      g.fillStyle(0xffffff, 0.35);
      g.fillCircle(a.x - 4, a.y - 4, 3);
      // 残りHP
      for (let i = 0; i < SHELL.hp; i++) {
        g.fillStyle(i < a.hp ? 0xff6b81 : 0x333a48, 1);
        g.fillCircle(a.x - (SHELL.hp - 1) * 5 + i * 10, a.y - SHELL.actorRadius - 10, 3.5);
      }
    }

    for (const p of f.particles) {
      fx.fillStyle(p.color, p.a);
      fx.fillCircle(p.x, p.y, p.r);
    }
  }
}
