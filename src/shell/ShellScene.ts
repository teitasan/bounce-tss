import * as Phaser from 'phaser';
import { ARENA, PIXEL } from '../config';

/** カメラの拡大率の基準（解像度を下げたぶん縮める）。コード中の拡大率はこれに対する倍率 */
const BASE_ZOOM = 1 / PIXEL;
import { ui } from '../ui';
import { B, L, PILLARS, R, SPAWNS, T, moveShell, resolveCircle, setArena, type Mover, type Rect, type WallGrid } from './arena';
import { CAVE, COLS, ROWS, generateCave, type CaveMap } from './cave';
import { CRAFT, CRATE_SPOTS, MATERIALS, MATERIAL_IDS, RECIPES, loadBook, randomMaterial, recipeKey, saveBook, type Crate, type Item, type Material } from './craft';
import { drawShell, shade, shellSvg, type Marks } from './visuals';
import { Net } from './net';
import { levelsOf, pizzaSvg, pizzaTextureSvg } from './pizza';
import { MAX_PLAYERS, ROOM_RE, type GuestMsg, type HostMsg } from './protocol';
import { CARD_RULE, Hand, MATCH, SHELLS, SPLIT_ANGLE, SPLIT_CHILD, STARTER_DECK, draftCandidates, type ShellSpec, type ShellType } from './cards';
import { EFFECTS, EFFECT_IDS, Rotation, SHELL_COUNT, buildSpec, effectCandidates, emptyLevels, starterLoadout, summary, type EffectId, type ShellLevels } from './custom';

/** plain: 甲羅バトル / cards: カード甲羅 / custom: カスタム甲羅 / craft: クラフト（箱を壊して素材を拾うと、その場で甲羅に入って効果になる） */
export type ShellMode = 'plain' | 'cards' | 'custom' | 'craft';

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
  countdown: 1.5, // ラウンド開始の 3・2・1
};

const COLORS = [0x6ef2ff, 0xff6b6b, 0xffd166, 0xb388ff];
const NAMES = ['あなた', 'CPU1', 'CPU2', 'CPU3'];

/** local: この端末の人 / remote: 通信でつながったほかの人 / bot: CPU */
type Ctrl = 'local' | 'remote' | 'bot';

interface Actor {
  id: number;
  name: string;
  color: number;
  /** CPU か（ctrl === 'bot'） */
  bot: boolean;
  ctrl: Ctrl;
  /** remote のとき、部屋でのプレイヤー ID */
  pid: string | null;
  /** remote のとき、最後に届いた操作 */
  input: { mx: number; my: number; aim: number; fire: boolean };
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
  /** クラフト：甲羅1〜3それぞれに入っている、組み合わせ待ちの素材（2つ目が入ると効果になる） */
  pend: (Material | null)[];
  ai: { think: number; moveX: number; moveY: number; throwTimer: number; strafe: number; pick: number };
}

interface Shell extends Mover {
  /** 通信で甲羅を見分けるための番号 */
  id: number;
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
  /** 試合の経過時間（秒）。リプレイの切り出しに使う */
  tm: number;
  actors: { x: number; y: number; aim: number; alive: boolean; inv: number; hp: number; color: number; targeted: boolean; orbits: { x: number; y: number; spec: ShellSpec; angle: number }[] }[];
  shells: { id: number; x: number; y: number; angle: number; spec: ShellSpec; fade: number; ownerColor: number; trail: { x: number; y: number }[]; live: Partial<Marks> }[];
  particles: { x: number; y: number; r: number; color: number; a: number }[];
  glints: { x: number; y: number; tx: number; ty: number; k: number; color: number }[];
  rings: { x: number; y: number; k: number; color: number }[];
  /** クラフト：置かれている箱と落ちている素材 */
  crates: { x: number; y: number; w: number; h: number; hp: number; shake: number }[];
  items: { x: number; y: number; kind: Material; age: number }[];
}

/** 2つのコマの間を t（0〜1）で補間する。キャラと周回甲羅は並び順、飛んでいる甲羅は番号で対応を取る */
function lerpFrame(a: Frame, b: Frame, t: number): Frame {
  const L = (x: number, y: number) => x + (y - x) * t;
  const angle = (x: number, y: number) => x + Math.atan2(Math.sin(y - x), Math.cos(y - x)) * t;
  const bShells = new Map(b.shells.map((s) => [s.id, s]));
  return {
    tm: L(a.tm, b.tm),
    actors: a.actors.map((p, i) => {
      const q = b.actors[i] ?? p;
      const sameOrbits = p.orbits.length === q.orbits.length;
      return {
        ...p,
        x: L(p.x, q.x),
        y: L(p.y, q.y),
        aim: angle(p.aim, q.aim),
        orbits: sameOrbits ? p.orbits.map((o, j) => ({ ...o, x: L(o.x, q.orbits[j].x), y: L(o.y, q.orbits[j].y), angle: angle(o.angle, q.orbits[j].angle) })) : p.orbits,
      };
    }),
    shells: a.shells.map((s) => {
      const q = bShells.get(s.id);
      return q ? { ...s, x: L(s.x, q.x), y: L(s.y, q.y), angle: angle(s.angle, q.angle) } : s;
    }),
    // 粒子は数が同じときだけ並び順で補間する（増減したコマはそのまま）
    particles: a.particles.length === b.particles.length ? a.particles.map((p, i) => ({ ...p, x: L(p.x, b.particles[i].x), y: L(p.y, b.particles[i].y) })) : a.particles,
    glints: a.glints,
    rings: a.rings,
    crates: a.crates,
    items: a.items,
  };
}

/** リプレイ：脱落の何コマ前から何コマ後までを、どの速さで流すか */
const REPLAY = { before: 1.7, after: 0.4, speed: 0.7, zoomMin: 1.1, zoomMax: 2.1, bufferSeconds: 4 };

/** 脱落の記録：どこで・いつ（試合の経過時間）・誰が誰に */
interface Kill {
  x: number;
  y: number;
  tm: number;
  victim: number;
  killer: number;
}

type State = 'countdown' | 'play' | 'paused' | 'result' | 'draft';

// ---- オンライン対戦の配信データ（ホスト → 参加者）。通信量を減らすため配列で詰める ----
type FxEvent = { e: string; [k: string]: unknown };
/** [x, y, aim, alive, inv, hp, wins, targeted, orbits[[x, y, specId, angle]], 投げる順, 手元にある甲羅のビット, 補充の残り秒, 手持ち数] */
type SnapActor = [number, number, number, number, number, number, number, number, [number, number, number, number][], number[], number, number[], number];
/** [id, x, y, angle, specId, fade, 投げた人の席, 模様のビット（1分裂 2貫通 4反発 8追尾）] */
type SnapShell = [number, number, number, number, number, number, number, number];
interface Snap {
  k: 'snap';
  tm: number;
  st: State;
  rd: number;
  cd: number;
  mo: boolean;
  rw: number;
  rs: boolean;
  seats: { name: string; pid: string | null }[];
  a: SnapActor[];
  s: SnapShell[];
  fx: FxEvent[];
  defs?: [number, ShellSpec][];
  lo?: ShellLevels[][];
  dr?: { ids: string[]; taken: number[]; order: number[]; turn: number; log: string[]; last: number; busy: boolean };
  /** 試合場（洞窟）の種。カスタム甲羅のみ */
  mp?: number;
}
const SNAP_HZ = 30;
/** 静的ファイルだけで公開する版（GitHub Pages）。オンライン対戦を出さない */
const OFFLINE_ONLY = import.meta.env.VITE_OFFLINE_ONLY === '1';
const OFFLINE_NAMES = ['あなた', 'CPU1', 'CPU2', 'CPU3'];

const TRAIL_LENGTH = 8; // 残像に使う過去の位置の数（1フレームに1つ）

const $ = (id: string) => document.getElementById(id)!;
/** 通信量を減らすための丸め */
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const readLocal = (k: string) => {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
};
const writeLocal = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 保存できなくても困らない */
  }
};

/** HUD・クラフト画面用の素材アイコン（ゲーム画面の drawMaterial と同じ形） */
function materialSvg(kind: Material, size: number): string {
  const body: Record<Material, string> = {
    feather: '<path d="M4 20 L20 4 L14 15Z M4 20 L20 4 L9 10Z" fill="#e8f4ff"/><path d="M3 21 L18 6" stroke="#8fa6bf" stroke-width="1.5"/>',
    eye: '<circle cx="12" cy="12" r="8" fill="#fff"/><circle cx="13.5" cy="12" r="4.5" fill="#e8453c"/><circle cx="14" cy="12" r="2" fill="#111"/>',
    stone: '<path d="M4 16 L7 6 L16 4 L21 11 L18 19 L9 20Z" fill="#9aa3b5"/><circle cx="10" cy="9" r="2.5" fill="#c9d0dc"/>',
    spring: '<path d="M6 21 L18 17 L6 13.5 L18 10 L6 6.5 L18 3" fill="none" stroke="#ffd166" stroke-width="2.5" stroke-linejoin="round"/>',
  };
  return `<svg class="mat-ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${body[kind]}</svg>`;
}

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
  /** リプレイ用の録画（直近 REPLAY.bufferSeconds 秒） */
  private rec: Frame[] = [];
  /** 試合の経過時間（秒）。ヒットストップ中も進め、リプレイで止まって見せる */
  private simTime = 0;
  /** 直近の脱落（リプレイの中心） */
  private lastKill: Kill | null = null;
  /** 脱落の少し後にリプレイを始める。then は終わった後の流れ */
  private pendingReplay: { t: number; kill: Kill; then: 'live' | 'winner' } | null = null;
  /** cursor は再生中の時刻、idx は今映しているコマ */
  private replay: { frames: Frame[]; cursor: number; idx: number; then: 'live' | 'winner'; kill: Kill } | null = null;
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
  private shellSeq = 0;
  /** 分裂でこのフレームに生まれた甲羅（更新ループの後で shells に足す） */
  private spawnQueue: Shell[] = [];
  /** 自分が脱落した後、R で早送りする */
  private fast = false;
  private matchOver = false;
  /** デバッグウィンドウ（カスタム甲羅で Tab） */
  private debugOpen = false;
  private debug = { invincible: false, cpuHold: false, hitbox: false, pizza: false };

  constructor(
    key = 'shell',
    private readonly mode: ShellMode = 'plain',
  ) {
    super(key);
  }

  private get cards() {
    return this.mode === 'cards';
  }

  /** 甲羅3つに効果を重ねる仕組み（カスタム甲羅とクラフト） */
  private get custom() {
    return this.mode === 'custom' || this.mode === 'craft';
  }

  private get craft() {
    return this.mode === 'craft';
  }

  /** オンライン対戦があるモード（GitHub Pages 版は部屋サーバーがないので出さない） */
  private get online() {
    return this.mode === 'custom' && !OFFLINE_ONLY;
  }

  /** ラウンドの合間にドラフトがあり、先に MATCH.winTarget 勝で優勝するモード */
  private get drafting() {
    return this.mode !== 'plain';
  }

  /** この端末のプレイヤーが操作する席（観戦中は -1） */
  private mySeat = 0;

  private get me(): Actor | undefined {
    return this.actors[this.mySeat];
  }

  private get maxStock() {
    return this.custom ? SHELL_COUNT : SHELL.maxStock;
  }

  create() {
    this.arenaBg = this.add.graphics().setDepth(0);
    this.drawArena();
    this.g = this.add.graphics().setDepth(10);
    // 演出（粉・ソース・残像）の層。ピザ屋の見た目なので光らせず普通に重ねる
    this.fx = this.add.graphics().setDepth(11);
    // 寄ったときに試合場の外が映らないように
    this.cameras.main.setBounds(0, 0, ARENA.width, ARENA.height);
    this.cameras.main.setZoom(BASE_ZOOM).centerOn(ARENA.width / 2, ARENA.height / 2);
    this.label = this.add
      .text(ARENA.width / 2, ARENA.height / 2 - 120, '', { fontFamily: 'system-ui, sans-serif', fontSize: '48px', fontStyle: 'bold', color: '#ffffff', stroke: '#000', strokeThickness: 6 })
      .setResolution(2 / PIXEL)
      .setOrigin(0.5)
      .setDepth(30);
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,SPACE') as ShellScene['keys'];
    const kb = this.input.keyboard!;
    kb.on('keydown-ESC', () => {
      if (performance.now() - this.unlockedAt > 250) this.togglePause();
    });
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
      else if (this.state === 'play' && this.me && !this.me.alive && this.role === 'offline') {
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
        const h = this.me!.hand;
        if (h) h.selected = i;
        this.renderHand();
      };
      kb.on('keydown-ONE', () => select(0));
      kb.on('keydown-TWO', () => select(1));
      kb.on('keydown-THREE', () => select(2));
      kb.on('keydown-Q', () => select((this.me!.hand!.selected + 2) % 3));
      kb.on('keydown-E', () => select((this.me!.hand!.selected + 1) % 3));
      this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => select((this.me!.hand!.selected + (dy > 0 ? 1 : 2)) % 3));
    }
    this.input.on('pointerdown', () => {
      if (this.replay) this.endReplay();
    });
    this.bindPointerLock();
    this.bindDom();
    // モード切替で戻ってきたとき、共有している DOM をこのモードにつなぎ直す
    this.events.on('wake', () => this.bindDom());

    this.actors = NAMES.slice(0, 1 + SHELL.bots).map((name, i) => ({
      id: i,
      name,
      color: COLORS[i],
      bot: i > 0,
      ctrl: (i === 0 ? 'local' : 'bot') as Ctrl,
      pid: null,
      input: { mx: 0, my: 0, aim: 0, fire: false },
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
      pend: [null, null, null],
      ai: { think: 0, moveX: 0, moveY: 0, throwTimer: 0, strafe: 1, pick: 0 },
    }));
    this.newRound();
    // ?r=部屋名 付きの URL で開いたら、その部屋のロビーを開く
    const room = new URLSearchParams(location.search).get('r');
    if (this.online && room) {
      this.openLobby(room.toLowerCase());
      this.enterRoom();
    }
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
    this.bindLobby();
  }

  private newRound() {
    this.round++;
    this.loVer++;
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
    this.lastKill = null;
    this.pendingReplay = null;
    this.replay = null;
    $('replay').hidden = true;
    // カスタム甲羅はラウンドごとに洞窟を作り直す（参加者はホストから届いた種で作る）
    if (this.mode === 'custom' && this.role !== 'guest') this.setCave(generateCave(Math.floor(Math.random() * 2 ** 31)));
    this.crates = this.craft ? CRATE_SPOTS.map((p) => ({ ...p, w: CRAFT.crateSize, h: CRAFT.crateSize, hp: CRAFT.crateHp, respawn: 0, shake: 0 })) : [];
    this.items = [];
    const cam = this.cameras.main;
    cam.setZoom(BASE_ZOOM);
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
    if (this.role !== 'offline') return;
    if (this.state === 'play') this.state = 'paused';
    else if (this.state === 'paused') this.state = 'play';
    ui.setPaused(this.state === 'paused');
  }

  update(_t: number, deltaMs: number) {
    const realDt = Math.min(deltaMs / 1000, 1 / 30);
    let dt = realDt;
    // 試合場の障害物をこのモードのものに差し替える（洞窟の壁、柱、クラフトの壊れる箱）
    setArena(this.cave ? [] : this.craft ? [...PILLARS, ...this.crates.filter((c) => c.respawn <= 0)] : PILLARS, this.walls);
    if (this.role === 'guest') return this.guestUpdate(realDt);
    const me = this.me;
    if (me && me.ctrl === 'local') this.updateHumanAim(me);
    this.updateReplay(realDt);

    // ヒットストップ中は時間を止めて描画だけする（録画には同じコマを重ねて、リプレイでも止まって見せる）
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      this.simTime += realDt;
      this.record();
      this.hostTick(realDt);
      this.render();
      return;
    }
    this.updateMain(realDt, dt);
  }

  /** リプレイ：裏で試合は進めたまま、録画を拡大して流す（ホストも参加者も同じ） */
  private updateReplay(realDt: number) {
    if (this.pendingReplay) {
      this.pendingReplay.t -= realDt;
      if (this.pendingReplay.t <= 0) {
        const p = this.pendingReplay;
        this.pendingReplay = null;
        this.startReplay(p.kill, p.then);
      }
    }
    if (this.replay) {
      const r = this.replay;
      r.cursor += realDt * REPLAY.speed;
      while (r.idx < r.frames.length - 1 && r.frames[r.idx + 1].tm <= r.cursor) r.idx++;
      if (r.idx >= r.frames.length - 1) this.endReplay();
      else this.aimReplayCamera(0.12);
    }
  }

  private updateMain(realDt: number, dt: number) {
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
        if (this.craft) this.updateCraft(dt, this.state === 'play');
        if (this.state === 'play') this.checkRoundEnd();
        this.simTime += dt;
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

    this.hostTick(realDt);
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
    const p = this.aimPoint();
    if (me.alive) me.aim = Math.atan2(p.y - me.y, p.x - me.x);
  }

  // ---- マウスの固定（ポインターロック） ----
  // ゲーム画面をクリックするとマウスを画面内に固定し、カーソルの代わりに照準を自前で動かす（画面外に出て操作を取られないように）。
  // Esc か、結果・ドラフト・ロビー・デバッグなどマウスで押す画面が出たら外す

  /** 固定中の照準の位置（試合場の座標） */
  private aim = { x: ARENA.width / 2, y: ARENA.height / 2 };

  private get locked() {
    return document.pointerLockElement === this.game.canvas;
  }

  /** マウスを固定してよい場面か（マウスで押す画面が出ていない） */
  private canLock() {
    return (this.state === 'play' || this.state === 'countdown') && $('lobby').hidden && $('draft').hidden && $('shell-result').hidden && !this.debugOpen;
  }

  private bindPointerLock() {
    const canvas = this.game.canvas;
    this.input.on('pointerdown', () => {
      if (this.locked || !this.canLock()) return;
      // 固定を始める位置は今のカーソルの位置
      const p = this.input.activePointer;
      this.aim = { x: p.worldX, y: p.worldY };
      void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.sys.isActive()) return;
      // 画面上の 1px が試合場の何 px か（拡大していないときのカメラ基準）
      const k = ARENA.width / canvas.getBoundingClientRect().width;
      this.aim.x = Math.max(L, Math.min(R, this.aim.x + e.movementX * k));
      this.aim.y = Math.max(T, Math.min(B, this.aim.y + e.movementY * k));
    });
    // 試合中に Esc で固定が外れたらポーズする。ブラウザによっては同じ Esc がゲームにも届くので、続けて届いた Esc は無視する
    document.addEventListener('pointerlockchange', () => {
      if (this.locked || !this.sys.isActive()) return;
      this.unlockedAt = performance.now();
      // ゲーム側で外した（デバッグを開いた等）ときはポーズしない
      if (this.selfUnlock) this.selfUnlock = false;
      else if (this.state === 'play' && this.role === 'offline') this.togglePause();
    });
  }

  private unlockedAt = 0;
  private selfUnlock = false;

  /** 照準の位置：固定中は自前の照準、それ以外はカーソル。マウスで押す画面が出たら固定を外す */
  private aimPoint() {
    if (this.locked) {
      if (!this.canLock() && !this.selfUnlock) {
        this.selfUnlock = true;
        document.exitPointerLock();
      }
      return this.aim;
    }
    const p = this.input.activePointer;
    return { x: p.worldX, y: p.worldY };
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
      if (a.ctrl === 'local') {
        if (this.keys.A.isDown) mx -= 1;
        if (this.keys.D.isDown) mx += 1;
        if (this.keys.W.isDown) my -= 1;
        if (this.keys.S.isDown) my += 1;
      } else if (a.ctrl === 'remote') {
        mx = a.input.mx;
        my = a.input.my;
        a.aim = a.input.aim;
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
      const wantThrow =
        a.ctrl === 'bot'
          ? a.ai.throwTimer <= 0 && !this.debug.cpuHold
          : a.ctrl === 'remote'
            ? a.input.fire
            : this.input.activePointer.leftButtonDown() || this.keys.SPACE.isDown;
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
        id: ++this.shellSeq,
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

    // クラフト：近くに素材が落ちていれば拾いに行く
    if (this.craft) {
      const it = this.items.reduce<Item | null>((best, i) => (Math.hypot(i.x - a.x, i.y - a.y) < (best ? Math.hypot(best.x - a.x, best.y - a.y) : 320) ? i : best), null);
      if (it) {
        const id = Math.hypot(it.x - a.x, it.y - a.y) || 1;
        mx = ((it.x - a.x) / id) * 1.5 + mx * 0.3;
        my = ((it.y - a.y) / id) * 1.5 + my * 0.3;
      }
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
      const cs = this.currentSpec(a);
      const shot = this.findShot(a, target, cs?.radius ?? SHELLS.normal.radius, cs?.curve ? cs.curve / cs.speed : 0);
      if (a.hand) a.ai.pick = CARD_RULE.pick ? this.pickCard(a.hand, shot) : 0;
      if (shot) {
        a.aim = shot.angle + (Math.random() - 0.5) * 0.12;
      } else if (this.currentSpec(a)?.homingTurn) {
        // 当たる角度がなくても、追尾甲羅なら相手の方へ投げておく
        a.aim = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.6;
      } else if (this.craft && this.nearestCrate(a, 360)) {
        // 相手を狙えないときは近くの箱を壊して素材を出す
        const c = this.nearestCrate(a, 360)!;
        a.aim = Math.atan2(c.y + c.h / 2 - a.y, c.x + c.w / 2 - a.x);
      } else {
        a.ai.throwTimer = 0.25;
      }
    } else {
      a.aim = Math.atan2(dy, dx);
    }
  }

  /** 距離 max 以内で一番近い、置かれている箱 */
  private nearestCrate(a: Actor, max: number): Crate | null {
    let best: Crate | null = null;
    let bestD = max;
    for (const c of this.crates) {
      if (c.respawn > 0) continue;
      const d = Math.hypot(c.x + c.w / 2 - a.x, c.y + c.h / 2 - a.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
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
  /** turn はカーブ甲羅が 1px 進むごとに曲がる角度（rad） */
  private findShot(a: Actor, target: Actor, radius: number, turn = 0): { angle: number; bounces: number } | null {
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
        if (turn) {
          const c = Math.cos(turn * 5);
          const sn = Math.sin(turn * 5);
          [sim.vx, sim.vy] = [sim.vx * c - sim.vy * sn, sim.vx * sn + sim.vy * c];
        }
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
      if (s.spec.curve) {
        // カーブ：速度の向きを時計回りに回す
        const c = Math.cos(s.spec.curve * dt);
        const sn = Math.sin(s.spec.curve * dt);
        [s.vx, s.vy] = [s.vx * c - s.vy * sn, s.vx * sn + s.vy * c];
      }
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
      }, (rc) => this.hitCrate(rc));
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
    this.addRing(s.x, s.y, SPLIT_CHILD.color);
    return [a - SPLIT_ANGLE, a + SPLIT_ANGLE].map((ang) => ({
      x: s.x,
      y: s.y,
      vx: Math.cos(ang) * SPLIT_CHILD.speed,
      vy: Math.sin(ang) * SPLIT_CHILD.speed,
      spec: SPLIT_CHILD,
      owner: s.owner,
      age: Math.max(s.age, SHELL.ownerGrace),
      bounces: 0,
      id: ++this.shellSeq,
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
    if (a === this.me && this.debug.invincible) return;
    a.hp -= 1;
    a.inv = SHELL.invincible;
    const sp = Math.hypot(dx, dy) || 1;
    const kb = SHELL.knockback * (spec.heavy ? 1.6 : 1);
    a.kx += (dx / sp) * kb;
    a.ky += (dy / sp) * kb;
    this.burst(a.x, a.y, 14, spec.color, 260, 0.4, 3);
    this.hitstop = Math.max(this.hitstop, a.bot ? 0.05 : 0.11);
    if (a === this.me) {
      this.cameras.main.shake(160, 0.01);
    } else if (a.ctrl === 'remote') {
      this.emit({ e: 'hit', seat: a.id });
    }
    if (a.hp <= 0) {
      a.alive = false;
      this.deadOrder.push(a);
      this.lastKill = { x: a.x, y: a.y, tm: this.simTime, victim: a.id, killer: (by ?? a).id };
      // 自分がやられたら、やられた場面をリプレイで見せる（決着した場合は checkRoundEnd 側でまとめる）
      if (a === this.me) this.pendingReplay = { t: 0.4, kill: this.lastKill, then: 'live' };
      else if (a.ctrl === 'remote') this.emit({ e: 'rp', kill: this.lastKill, then: 'live' });
      this.burst(a.x, a.y, 30, a.color, 340, 0.7, 4);
      this.hitstop = Math.max(this.hitstop, 0.14);
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
    const gx = s.x - (nx / nl) * s.spec.radius;
    const gy = s.y - (ny / nl) * s.spec.radius;
    this.glints.push({ x: gx, y: gy, tx: -ny / nl, ty: nx / nl, life: 0.28, color: s.spec.color });
    this.emit({ e: 'g', x: r1(gx), y: r1(gy), tx: r2(-ny / nl), ty: r2(nx / nl), c: s.spec.color });
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
    // 参加者にも同じ流れを伝える
    if (this.lastKill) this.emit({ e: 'rp', kill: this.lastKill, then: 'winner' });
    else this.emit({ e: 'fw' });
  }

  /** 勝者に寄ってスローモーション。少し待って結果を出す */
  private focusWinner() {
    const w = this.roundWinner;
    const cam = this.cameras.main;
    cam.setZoom(BASE_ZOOM);
    cam.centerOn(ARENA.width / 2, ARENA.height / 2);
    // 参加者はカメラだけ。結果を出すタイミングはホストの配信に合わせる
    if (this.role !== 'guest') this.winnerFocus = 0.8;
    if (w) {
      cam.pan(w.x, w.y, 450, 'Sine.easeOut');
      cam.zoomTo(1.6 * BASE_ZOOM, 450, 'Sine.easeOut');
    }
  }

  // ---------------- リプレイ ----------------

  /** 今の状態を1コマ録画する */
  private record() {
    this.pushRec(this.capture());
  }

  private pushRec(f: Frame) {
    this.rec.push(f);
    while (this.rec.length > 0 && this.rec[0].tm < f.tm - REPLAY.bufferSeconds) this.rec.shift();
  }

  private startReplay(kill: Kill, then: 'live' | 'winner') {
    const frames = this.rec.filter((f) => f.tm >= kill.tm - REPLAY.before && f.tm <= kill.tm + REPLAY.after);
    if (frames.length < 10) {
      if (then === 'winner') this.focusWinner();
      return;
    }
    this.replay = { frames, cursor: frames[0].tm, idx: 0, then, kill };
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
    const f = this.replayFrame();
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
    const span = r.frames[r.frames.length - 1].tm - r.frames[0].tm || 1;
    const push = 1 + 0.15 * Math.min(1, (r.cursor - r.frames[0].tm) / span);
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
    cam.setZoom(c.zoom * BASE_ZOOM);
    cam.centerOn(c.x, c.y);
  }

  private replayCam = { x: 0, y: 0, zoom: 1 };

  /**
   * リプレイの今のコマ。録画は1秒に60コマ（参加者は30コマ）しかないので、スロー再生だと同じコマが
   * 不規則に続いてカクついて見える。前後2コマの間を再生位置で補間してなめらかにする
   */
  private replayFrame(): Frame {
    const r = this.replay!;
    const a = r.frames[r.idx];
    const b = r.frames[Math.min(r.frames.length - 1, r.idx + 1)];
    const span = b.tm - a.tm;
    if (b === a || span <= 0) return a;
    const t = Math.max(0, Math.min(1, (r.cursor - a.tm) / span));
    return lerpFrame(a, b, t);
  }

  private endReplay() {
    const r = this.replay;
    if (!r) return;
    this.replay = null;
    $('replay').hidden = true;
    const cam = this.cameras.main;
    cam.setZoom(BASE_ZOOM);
    cam.centerOn(ARENA.width / 2, ARENA.height / 2);
    if (r.then === 'winner') this.focusWinner();
  }

  private roundWinner: Actor | null = null;

  private showResult() {
    const w = this.roundWinner;
    $('shell-result-tag').textContent = '';
    $('shell-result-stars').innerHTML = '';
    $('shell-result-build').innerHTML = '';
    const title = $('shell-winner');
    title.style.color = '';
    const who = w === this.me ? 'あなた' : w?.name;
    title.textContent = !w ? '引き分け' : this.matchOver ? `${who} が${MATCH.winTarget}勝で優勝` : w === this.me ? 'あなたの勝ち！' : `${who} の勝ち`;
    const next = $('shell-next') as HTMLButtonElement;
    next.textContent = !this.drafting ? '次のラウンド（R）' : this.matchOver ? '新しい試合（R）' : this.craft ? '次のラウンド（R）' : this.custom ? '効果を選ぶ（R）' : 'カードを選ぶ（R）';
    next.disabled = this.role === 'guest';
    if (this.role === 'guest') next.textContent = 'ホストが進めるのを待っています';
    $('shell-result').hidden = false;
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
          return `<div class="bcard" style="--c:${hex(sp.color)}">${this.icon(sp, 40)}<strong>${sp.name}</strong><div class="badges">${this.badges(lv)}</div></div>`;
        })
        .join('');
    return this.buildSpecs(a)
      .map((sp) => `<div class="bcard small" style="--c:${hex(sp.color)}">${this.icon(sp, 28)}<span>${sp.name}</span></div>`)
      .join('');
  }

  /** 結果画面の次へ：甲羅バトルはすぐ次のラウンド、それ以外はドラフトか新しい試合 */
  private proceed() {
    if (this.role === 'guest') return;
    if (!this.drafting) return this.newRound();
    $('shell-result').hidden = true;
    // オンラインの次の試合は、部屋の顔ぶれで席を決め直す（途中で入った人も加わる）
    if (this.matchOver && this.role === 'host') return this.hostStartMatch();
    if (this.matchOver) {
      this.matchOver = false;
      this.round = 0;
      for (const a of this.actors) {
        a.wins = 0;
        a.deck = [...STARTER_DECK];
        a.loadout = starterLoadout();
        a.pend = [null, null, null];
      }
      return this.newRound();
    }
    // クラフトは試合中に甲羅が育つので、合間の画面はない
    if (this.craft) return this.newRound();
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
    if (a.ctrl === 'bot') {
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
    if (this.state !== 'draft' || this.draftBusy || !this.isMyDraftTurn() || !this.draft[i] || this.draft[i].takenBy) return;
    this.draftSel = this.draftSel === i ? null : i;
    this.renderDraft();
  }

  /** 当てはめ先のクリック */
  private draftApply(ti: number) {
    if (this.state !== 'draft' || this.draftBusy || this.draftSel === null) return;
    if (!this.isMyDraftTurn()) return;
    if (this.role === 'guest') {
      this.net!.toHost({ k: 'draftApply', ci: this.draftSel, ti });
      this.draftSel = null;
      return;
    }
    this.applyCandidate(this.me!, this.draftSel, ti);
    this.draftSel = null;
    this.draftTurn++;
    this.advanceDraft();
  }

  private draftPass() {
    if (this.state !== 'draft' || this.draftBusy) return;
    if (!this.isMyDraftTurn()) return;
    if (this.role === 'guest') {
      this.net!.toHost({ k: 'draftPass' });
      this.draftSel = null;
      return;
    }
    this.applyCandidate(this.me!, null);
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
    // カード甲羅：ノーマル甲羅があれば入れ替える。なければ半々で、交換しないか一番多い種類と入れ替える
    const normal = a.deck.indexOf('normal');
    if (normal >= 0) return this.applyCandidate(a, ci, normal);
    if (Math.random() < 0.5) return this.applyCandidate(a, null);
    const count = (t: ShellType) => a.deck.filter((x) => x === t).length;
    const most = a.deck.reduce((best, t, i) => (count(t) > count(a.deck[best]) ? i : best), 0);
    this.applyCandidate(a, ci, most);
  }

  /** ドラフトの四隅：プレイヤー1〜4の甲羅（カード甲羅はデッキ）と、選んでいる番か */
  private dpLogLen = 0;

  private renderDraftPlayers() {
    const turn = this.draftOrder[this.draftTurn];
    // 新しく記録が増えたときだけ、その人の甲羅を光らせる（選び直しの描き直しでは光らせない）
    const newest = this.draftLog.length !== this.dpLogLen ? this.draftLog[this.draftLog.length - 1] : undefined;
    this.dpLogLen = this.draftLog.length;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const el = $(`draft-p${i}`);
      const a = this.actors[i];
      el.className = 'dp';
      if (!a) {
        el.classList.add('empty');
        el.innerHTML = '';
        continue;
      }
      const pos = this.draftOrder.indexOf(a);
      const state = a === turn ? (a === this.me ? 'あなたの番' : '選んでいます…') : pos >= 0 && pos < this.draftTurn ? '選び終えた' : `${pos + 1}番目に選ぶ`;
      el.classList.toggle('now', a === turn);
      el.style.setProperty('--c', hex(a.color));
      const log = newest?.startsWith(`${a.name}：`) ? newest : undefined;
      const stars = Array.from({ length: MATCH.winTarget }, (_, k) => (k < a.wins ? '<b>★</b>' : '★')).join('');
      let body: string;
      if (this.custom) {
        body = a.loadout
          .map((lv, k) => {
            const sp = buildSpec(lv, k);
            const fresh = log?.includes(`甲羅${k + 1} に`) ? ' fresh' : '';
            return `<div class="dp-shell${fresh}">${this.icon(sp, 34)}<div><div class="nm">${sp.name}</div><div class="badges">${this.badges(lv)}</div></div></div>`;
          })
          .join('');
      } else {
        body = `<div class="dp-deck">${a.deck.map((t) => `<span style="--c:${hex(SHELLS[t].color)}">${SHELLS[t].name}</span>`).join('')}</div>`;
      }
      el.innerHTML =
        `<div class="dp-head"><strong>${escapeHtml(a.name)}</strong>${a === this.me ? '<span class="you">あなた</span>' : ''}<span class="stars">${stars}</span></div>` +
        `<div class="dp-state">${state}</div>${body}`;
    }
  }

  private renderDraft() {
    this.renderDraftPlayers();
    const me = this.me;
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
      `<div class="turn">${!turnActor ? '全員選び終えた' : turnActor === me ? 'あなたの番' : `${turnActor.name} が選んでいます…`}</div>`;
    $('draft-log').innerHTML = this.draftLog.map((l) => `<li>${l}</li>`).join('');

    const box = $('draft-choices');
    box.innerHTML = '';
    this.draft.forEach((c, i) => {
      const info = this.candidateInfo(c.id);
      const icon = this.custom
        ? this.debug.pizza
          ? pizzaSvg({ [c.id]: 1 }, 44)
          : shellSvg(this.effectPreviewSpec(c.id as EffectId), 44)
        : this.icon(SHELLS[c.id as ShellType], 44);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `choice dchoice${this.draftSel === i ? ' picked' : ''}${c.takenBy && i === this.lastTaken ? ' just-taken' : ''}`;
      btn.disabled = !!c.takenBy || this.draftBusy || !this.isMyDraftTurn();
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
    const specs = me ? this.buildSpecs(me) : [];
    specs.forEach((sp, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `deckcard tcard${this.draftSel !== null ? ' armed' : ''}`;
      btn.disabled = this.draftSel === null || this.draftBusy;
      btn.style.setProperty('--c', hex(sp.color));
      let body = `${this.icon(sp, this.custom ? 36 : 26)}<span class="tc-name">${sp.name}</span>`;
      if (this.custom) {
        body += `<div class="badges">${this.badges(me!.loadout[i])}</div>`;
        if (this.draftSel !== null) {
          // 付けた後の姿を先に見せる
          const after = { ...me!.loadout[i] };
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

  // ---------------- クラフト ----------------
  // 箱を甲羅で壊すと素材が出る。触れて拾い、ラウンドの合間に素材2つを組み合わせて甲羅に効果を付ける

  private crates: Crate[] = [];
  private items: Item[] = [];
  private itemSeq = 0;
  /** 作ったことのあるレシピ（図鑑） */
  private book = loadBook();

  /** 甲羅が障害物で跳ねた：箱なら傷つけ、壊れたら素材を出す */
  private hitCrate(rc: Rect) {
    const c = rc as Crate;
    if (!this.craft || c.hp === undefined || c.respawn > 0 || c.hp <= 0) return;
    c.hp--;
    c.shake = 0.15;
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    this.burst(cx, cy, 5, 0xc98a45, 140, 0.25, 2.5);
    if (c.hp > 0) return;
    c.respawn = CRAFT.crateRespawn;
    this.burst(cx, cy, 16, 0xc98a45, 240, 0.45, 3);
    const a = Math.random() * Math.PI * 2;
    this.items.push({ id: ++this.itemSeq, kind: randomMaterial(), x: cx, y: cy, vx: Math.cos(a) * 160, vy: Math.sin(a) * 160, age: 0 });
  }

  /** 箱が戻る・素材が転がる・拾う */
  private updateCraft(dt: number, canPick: boolean) {
    for (const c of this.crates) {
      c.shake = Math.max(0, c.shake - dt);
      if (c.respawn <= 0) continue;
      c.respawn -= dt;
      if (c.respawn > 0) continue;
      // 上に誰かいれば、どくまで待つ
      const blocked = this.actors.some((a) => a.alive && a.x > c.x - SHELL.actorRadius && a.x < c.x + c.w + SHELL.actorRadius && a.y > c.y - SHELL.actorRadius && a.y < c.y + c.h + SHELL.actorRadius);
      if (blocked) c.respawn = 0.5;
      else c.hp = CRAFT.crateHp;
    }
    const damp = Math.exp(-6 * dt);
    for (const it of this.items) {
      it.age += dt;
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      it.vx *= damp;
      it.vy *= damp;
      resolveCircle(it, CRAFT.itemRadius);
    }
    if (!canPick) return;
    this.items = this.items.filter((it) => {
      if (it.age < 0.3) return true;
      const a = this.actors.find((x) => x.alive && Math.hypot(x.x - it.x, x.y - it.y) < CRAFT.pickupRadius);
      if (!a) return true;
      this.burst(it.x, it.y, 8, MATERIALS[it.kind].color, 120, 0.25, 2);
      this.addMaterial(a, it.kind);
      return false;
    });
  }

  /**
   * 拾った素材を、今の甲羅（次に投げる甲羅。全部補充中なら順番が一番早い甲羅）に入れる。
   * その甲羅に素材が2つ揃ったら、組み合わせの効果がその場で付く
   */
  private addMaterial(a: Actor, m: Material) {
    const slot = this.currentSlot(a) ?? a.rot?.order()[0] ?? 0;
    const first = a.pend[slot];
    if (!first) {
      a.pend[slot] = m;
      this.renderHand();
      return;
    }
    a.pend[slot] = null;
    const key = recipeKey(first, m);
    const r = RECIPES.get(key)!;
    for (const e of r.eff) a.loadout[slot][e]++;
    a.specs[slot] = buildSpec(a.loadout[slot], slot);
    this.loVer++;
    let text = `甲羅${slot + 1} ${this.effNames(r.eff)}！`;
    if (a === this.me && !this.book.has(key)) {
      this.book.add(key);
      saveBook(this.book);
      text = `新レシピ ${MATERIALS[first].name}＋${MATERIALS[m].name}＝${this.effNames(r.eff)}`;
    }
    this.burst(a.x, a.y, 18, a.specs[slot].color, 220, 0.45, 3);
    this.addRing(a.x, a.y, a.specs[slot].color);
    this.popText(a.x, a.y - 34, text, a.specs[slot].color);
    this.renderHand();
    this.renderHud();
  }

  /** キャラの頭上に文字を出して、上に流しながら消す */
  private popText(x: number, y: number, text: string, color: number) {
    const t = this.add
      .text(x, y, text, { fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold', color: hex(color), stroke: '#000', strokeThickness: 5 })
      .setResolution(2 / PIXEL)
      .setOrigin(0.5)
      .setDepth(31);
    this.tweens.add({ targets: t, y: y - 36, alpha: 0, delay: 700, duration: 700, onComplete: () => t.destroy() });
  }

  /** 「追尾×2」のように効果を並べる */
  private effNames(eff: EffectId[]) {
    const n = EFFECTS[eff[0]].name;
    return eff.every((e) => e === eff[0]) && eff.length > 1 ? `${n}×${eff.length}` : eff.map((e) => EFFECTS[e].name).join('・');
  }

  // ---------------- 演出・描画 ----------------

  private addRing(x: number, y: number, color: number) {
    this.rings.push({ x, y, life: 0.3, color });
    this.emit({ e: 'r', x: r1(x), y: r1(y), c: color });
  }

  /** 粒子を飛ばす。ホストなら参加者にも同じ演出を知らせる */
  private burst(x: number, y: number, n: number, color: number, speed: number, life: number, r: number, local = false) {
    if (!local) this.emit({ e: 'b', x: r1(x), y: r1(y), n, c: color, sp: speed, l: life, r });
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

  // 以下3つは呼び出し側との互換のための印（表示を作り直させたいときに使う）
  private hudBuilt = false;
  private handKey = '';
  private introRound = -1;

  /** 左上のプレイヤー一覧：名前・HP・勝ち数と、デッキ／甲羅の色 */
  private renderHud() {
    if (this.actors.length === 0) return;
    $('shell-hud').innerHTML =
      `<div class="muted">ラウンド ${this.round}${this.drafting ? `（先に${MATCH.winTarget}勝）` : ''}</div>` +
      this.actors
        .map((a) => {
          const hearts = a.alive ? '♥'.repeat(a.hp) + '♡'.repeat(Math.max(0, SHELL.hp - a.hp)) : '脱落';
          const items = this.drafting ? this.targets(a) : [];
          const deck = items.length
            ? `<div class="sdeck${this.custom ? ' big' : ''}">${items.map((t) => `<i style="background:${hex(t.color)}" title="${escapeHtml(t.label)}"></i>`).join('')}</div>`
            : '';
          const mats = this.craft && a.pend.some(Boolean) ? `<div class="smats">${a.pend.map((m) => (m ? materialSvg(m, 14) : '<span class="mat-empty"></span>')).join('')}</div>` : '';
          return `<div class="srow${a.alive ? '' : ' out'}"><span class="dot" style="background:${hex(a.color)}"></span><span>${escapeHtml(a.name)}</span><span class="hearts">${hearts}</span><span class="wins">${a.wins}勝</span></div>${deck}${mats}`;
        })
        .join('');
  }

  /** 画面下の手札：今投げる甲羅と、次に来る甲羅 */
  private renderHand() {
    const el = $('hand');
    const me = this.me;
    if (!me || (!me.hand && !me.rot)) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const card = (sp: ShellSpec | null, cls: string, key: string, extra = '') => {
      if (!sp) return `<div class="card empty ${cls}"><span class="key">${key}</span><span class="cname">補充中…</span></div>`;
      return `<div class="card ${cls}" style="border-left:6px solid ${hex(sp.color)}"><span class="key">${key}</span><span class="cname">${sp.name}</span><span class="cdesc">${sp.desc}</span>${extra}</div>`;
    };
    const mini = (sp: ShellSpec, i: number) =>
      `<div class="card next" style="border-left:6px solid ${hex(sp.color)}"><span class="key">${i === 0 ? '次' : i + 1}</span><span class="cname">${sp.name}</span></div>`;
    if (me.rot) {
      const cur = this.currentSlot(me);
      el.innerHTML = me.rot
        .order()
        .map((slot) => {
          const sp = me.specs[slot];
          if (!sp) return '';
          // クラフト：この甲羅に入っている、組み合わせ待ちの素材
          const m = this.craft ? me.pend[slot] : null;
          const pend = m ? `<span class="cpend">${materialSvg(m, 18)}＋？</span>` : '';
          if (!me.ready[slot]) return `<div class="card empty"><span class="key">${slot + 1}</span><span class="cname">${sp.name} 補充中…</span>${pend}</div>`;
          return card(sp, slot === cur ? 'selected' : '', slot === cur ? '今' : `${slot + 1}`, pend);
        })
        .join('');
      return;
    }
    const h = me.hand!;
    const spec = (t: ShellType | null) => (t ? SHELLS[t] : null);
    if (CARD_RULE.pick) {
      el.innerHTML = h.slots.map((t, i) => card(spec(t), i === h.selected ? 'selected' : '', `${i + 1}`)).join('') + mini(SHELLS[h.upcoming(1)[0]], 0);
    } else {
      el.innerHTML = card(spec(h.slots[0]), 'selected', '今') + h.upcoming(CARD_RULE.previewCount).map((t, i) => mini(SHELLS[t], i)).join('');
    }
  }

  /** ラウンド開始の 3・2・1（画面中央の文字） */
  private renderIntro() {
    $('round-intro').hidden = true;
    if (this.state === 'countdown' && !this.replay) {
      this.label.setText(`${Math.max(1, Math.ceil(this.countdown / (SHELL.countdown / 3)))}`).setFontSize(48);
    }
  }

  // ---------------- ピザの見た目 ----------------
  // ピザは SVG を一度画像に変換し、Image を使い回して貼る（読み込み中は今までの甲羅の絵で代用）

  private pizzaPool: Phaser.GameObjects.Image[] = [];
  private pizzaUsed = 0;
  private pizzaLoading = new Set<string>();

  /** 画像の準備ができていればキーを返す。まだなら読み込みを始めて null */
  private pizzaKey(spec: ShellSpec, cluster: boolean): string | null {
    const { key, svg } = pizzaTextureSvg(spec, cluster);
    if (this.textures.exists(key)) return key;
    if (!this.pizzaLoading.has(key)) {
      this.pizzaLoading.add(key);
      const img = new Image();
      img.onload = () => {
        if (!this.textures.exists(key)) this.textures.addImage(key, img);
      };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }
    return null;
  }

  /** ピザを1枚貼る。半径 r はピザの生地の半径（当たり判定と同じ） */
  private drawPizza(x: number, y: number, r: number, spec: ShellSpec, rot: number, alpha: number, cluster: boolean): boolean {
    if (!this.debug.pizza) return false;
    const key = this.pizzaKey(spec, cluster);
    if (!key) return false;
    let img = this.pizzaPool[this.pizzaUsed];
    if (!img) {
      img = this.add.image(0, 0, key).setDepth(10.5);
      this.pizzaPool.push(img);
    }
    this.pizzaUsed++;
    // SVG は viewBox 112 のうち直径 96 が生地
    const d = r * 2 * (112 / 96);
    img.setTexture(key).setPosition(x, y).setRotation(rot).setAlpha(alpha).setDisplaySize(d, d).setVisible(true);
    return true;
  }

  /** HUD のアイコン（ピザ表示ならピザ） */
  private icon(spec: ShellSpec, size: number) {
    return this.debug.pizza ? pizzaSvg(levelsOf(spec), size) : shellSvg(spec, size);
  }

  /** 周回している手持ちの甲羅。拡散（一度に複数投げる）は小さな円3つで描く。angle は周回の進む向き */
  private drawOrbitShell(x: number, y: number, spec: ShellSpec, angle: number) {
    const ways = spec.ways ?? 1;
    if (this.drawPizza(x, y, spec.radius * (ways > 1 ? 1.15 : 1), spec, angle, 1, true)) return;
    // 色の円に白い縁。拡散は小さな円3つ
    const g = this.g;
    const r = ways > 1 ? spec.radius * 0.7 : spec.radius;
    const spread = ways > 1 ? spec.radius * 0.85 : 0;
    for (let i = 0; i < ways; i++) {
      const a = -Math.PI / 2 + (i / ways) * Math.PI * 2;
      const cx = x + Math.cos(a) * spread;
      const cy = y + Math.sin(a) * spread;
      g.fillStyle(spec.color, 1);
      g.fillCircle(cx, cy, r);
      g.lineStyle(spec.heavy ? 3 : ways > 1 ? 1.5 : 2, 0xeaffea, 1);
      g.strokeCircle(cx, cy, r);
    }
  }

  // ================= オンライン対戦 =================
  // ホスト（部屋に最初に入った人）がゲームを計算し、状態を約30回/秒で配る。
  // 参加者は操作をホストに送り、届いた状態をなめらかにつないで描く。演出（粒子・光・輪）は通知を受けて手元で再生する。

  /** offline: ひとりで（CPU と）/ host: 部屋のホスト / guest: 参加者（または観戦） */
  private role: 'offline' | 'host' | 'guest' = 'offline';
  private net: Net | null = null;
  private fxOut: FxEvent[] = [];
  private snapAcc = 0;
  private specIds = new Map<ShellSpec, number>();
  private specSent = new Set<number>();
  private specSeq = 0;
  /** 甲羅のレベル（loadout）が変わった回数。変わったら配信に載せる */
  private loVer = 0;
  private loSent = -1;
  private loAcc = 0;
  private specDefs = new Map<number, ShellSpec>();
  private snapPrev: { at: number; s: Snap } | null = null;
  private snapCur: { at: number; s: Snap } | null = null;
  private guestTrails = new Map<number, { x: number; y: number }[]>();
  private inputAcc = 0;
  private hostAtStart = '';
  private draftKey = '';
  private lobbyMsg = '';

  /** ホスト：参加者にも同じ演出を知らせる */
  private emit(ev: FxEvent) {
    if (this.role === 'host') this.fxOut.push(ev);
  }

  private isMyDraftTurn() {
    return !!this.me && this.draftOrder[this.draftTurn] === this.me;
  }

  /** ホスト：一定間隔で状態を配る */
  private hostTick(realDt: number) {
    if (this.role !== 'host' || !this.net) return;
    this.snapAcc += realDt;
    this.loAcc += realDt;
    if (this.snapAcc < 1 / SNAP_HZ) return;
    this.snapAcc = 0;
    this.sendSnap();
  }

  private sendSnap() {
    const defs: [number, ShellSpec][] = [];
    const sid = (sp: ShellSpec) => {
      let id = this.specIds.get(sp);
      if (id === undefined) {
        id = ++this.specSeq;
        this.specIds.set(sp, id);
      }
      if (!this.specSent.has(id)) {
        this.specSent.add(id);
        defs.push([id, sp]);
      }
      return id;
    };
    const targeted = new Set(this.shells.filter((s) => !s.dead && s.target && !s.homingOff).map((s) => s.target!));
    const a: SnapActor[] = this.actors.map((x) => [
      r1(x.x),
      r1(x.y),
      r2(x.aim),
      x.alive ? 1 : 0,
      r2(x.inv),
      x.hp,
      x.wins,
      targeted.has(x) ? 1 : 0,
      x.alive ? this.orbits(x).map((o) => [r1(o.x), r1(o.y), sid(o.spec), r2(Math.atan2(o.y - x.y, o.x - x.x) + Math.PI / 2)] as [number, number, number, number]) : [],
      x.rot ? x.rot.order() : [],
      x.ready.reduce((b, v, i) => (v ? b | (1 << i) : b), 0),
      x.slotRefill.map(r2),
      x.stock,
    ]);
    const sh: SnapShell[] = this.shells
      .filter((s) => !s.dead)
      .map((s) => {
        const bits =
          (s.bounces < (s.spec.splits ?? (s.spec.split ? 1 : 0)) ? 1 : 0) |
          (s.pierceLeft > 0 ? 2 : 0) |
          (s.reboundLeft > 0 ? 4 : 0) |
          (s.spec.homingTurn && !s.homingOff ? 8 : 0);
        const fade = s.age > s.spec.life - 1.5 ? 0.5 + 0.5 * Math.sin(s.age * 30) : 1;
        return [s.id, r1(s.x), r1(s.y), r2(Math.atan2(s.vy, s.vx)), sid(s.spec), r2(fade), s.owner.id, bits];
      });
    const msg: Snap = {
      k: 'snap',
      tm: r2(this.simTime),
      st: this.state,
      rd: this.round,
      cd: r2(this.countdown),
      mo: this.matchOver,
      rw: this.roundWinner?.id ?? -1,
      rs: !$('shell-result').hidden,
      seats: this.actors.map((x) => ({ name: x.name, pid: x.ctrl === 'local' ? this.net!.you : x.pid })),
      a,
      s: sh,
      fx: this.fxOut,
    };
    if (this.cave) msg.mp = this.cave.seed;
    if (defs.length) msg.defs = defs;
    if (this.loSent !== this.loVer || this.loAcc > 2) {
      msg.lo = this.actors.map((x) => x.loadout);
      this.loSent = this.loVer;
      this.loAcc = 0;
    }
    if (this.state === 'draft')
      msg.dr = {
        ids: this.draft.map((c) => c.id),
        taken: this.draft.map((c) => c.takenBy?.id ?? -1),
        order: this.draftOrder.map((x) => x.id),
        turn: this.draftTurn,
        log: this.draftLog,
        last: this.lastTaken,
        busy: this.draftBusy,
      };
    this.net!.toAll(msg as unknown as HostMsg);
    this.fxOut = [];
  }

  /** ホスト：参加者から届いた操作 */
  private onPeer(from: string, d: GuestMsg) {
    if (this.role !== 'host') return;
    const a = this.actors.find((x) => x.ctrl === 'remote' && x.pid === from);
    if (!a) return;
    if (d.k === 'input') {
      const c = (v: unknown) => Math.max(-1, Math.min(1, Number(v) || 0));
      a.input = { mx: c(d.mx), my: c(d.my), aim: Number(d.aim) || 0, fire: !!d.fire };
      return;
    }
    if (this.state !== 'draft' || this.draftBusy || this.draftOrder[this.draftTurn] !== a) return;
    if (d.k === 'draftApply') {
      const ci = d.ci | 0;
      const ti = d.ti | 0;
      const max = this.custom ? SHELL_COUNT : a.deck.length;
      if (!this.draft[ci] || this.draft[ci].takenBy || ti < 0 || ti >= max) return;
      this.applyCandidate(a, ci, ti);
    } else {
      this.applyCandidate(a, null);
    }
    this.draftTurn++;
    this.advanceDraft();
  }

  /** 部屋の顔ぶれが変わった */
  private onRoom() {
    const net = this.net!;
    if (this.role === 'host') {
      // 抜けた人の席は CPU が引き継ぐ。新しく入った人には甲羅の性能を送り直す
      for (const a of this.actors) {
        if (a.ctrl === 'remote' && !net.players.some((p) => p.id === a.pid)) {
          a.ctrl = 'bot';
          a.bot = true;
          a.pid = null;
          a.name = `${a.name}(CPU)`;
          this.hudBuilt = false;
        }
      }
      this.specSent.clear();
      this.loSent = -1;
      // ドラフトで順番待ちだった人が抜けたら CPU に選ばせて進める
      const turn = this.draftOrder[this.draftTurn];
      if (this.state === 'draft' && turn?.ctrl === 'bot' && !this.draftBusy) this.advanceDraft();
    } else if (this.role === 'guest' && net.host !== this.hostAtStart) {
      // ホストが抜けたら試合は続けられない
      this.lobbyMsg = 'ホストが抜けたので試合が終わりました';
      this.toLobby();
    }
    this.renderLobby();
    this.renderOnlineButton();
  }

  /** 参加者：ホストから届いたもの */
  private onHostMsg(d: HostMsg) {
    if (d.k === 'start') return this.guestStart(d.seats as Snap['seats']);
    if (d.k === 'snap') {
      const snap = d as unknown as Snap;
      // 試合の途中で入った人は観戦として加わる
      if (this.role !== 'guest' && !this.net!.isHost) this.guestStart(snap.seats);
      if (this.role === 'guest') this.applySnap(snap);
    }
  }

  /** ホスト：試合を始める。部屋の人を席に座らせ、空いた席は CPU */
  private hostStartMatch() {
    const net = this.net!;
    const players = net.players.slice(0, MAX_PLAYERS);
    this.role = 'host';
    this.actors.forEach((a, i) => {
      const p = players[i];
      a.input = { mx: 0, my: 0, aim: 0, fire: false };
      if (!p) Object.assign(a, { ctrl: 'bot', bot: true, pid: null, name: `CPU${i}` });
      else Object.assign(a, { ctrl: p.id === net.you ? 'local' : 'remote', bot: false, pid: p.id, name: p.name });
    });
    this.mySeat = this.actors.findIndex((a) => a.ctrl === 'local');
    this.specSent.clear();
    this.loSent = -1;
    net.send({ t: 'phase', inMatch: true });
    net.toAll({ k: 'start', seats: this.actors.map((a) => ({ name: a.name, pid: a.pid })) });
    this.closeLobby();
    this.resetMatch();
  }

  /** 新しい試合：勝ち数と甲羅を最初の状態に戻す */
  private resetMatch() {
    this.matchOver = false;
    this.round = 0;
    for (const a of this.actors) {
      a.wins = 0;
      a.deck = [...STARTER_DECK];
      a.loadout = starterLoadout();
      a.pend = [null, null, null];
    }
    this.hudBuilt = false;
    $('draft').hidden = true;
    $('shell-result').hidden = true;
    this.newRound();
  }

  /** 参加者：試合に加わる（席がなければ観戦） */
  private guestStart(seats: Snap['seats']) {
    const net = this.net!;
    this.role = 'guest';
    this.hostAtStart = net.host;
    seats.forEach((p, i) => {
      const a = this.actors[i];
      if (!a) return;
      Object.assign(a, { name: p.name, pid: p.pid, ctrl: p.pid === net.you ? 'local' : p.pid ? 'remote' : 'bot', bot: !p.pid });
    });
    this.mySeat = seats.findIndex((p) => p.pid === net.you);
    for (const a of this.actors) {
      a.wins = 0;
      a.loadout = starterLoadout();
      a.specs = a.loadout.map((lv, i) => buildSpec(lv, i));
    }
    this.round = -1;
    this.snapPrev = this.snapCur = null;
    this.guestTrails.clear();
    this.resetView();
    this.hudBuilt = false;
    this.handKey = '';
    this.introRound = -1;
    $('draft').hidden = true;
    $('shell-result').hidden = true;
    this.closeLobby();
  }

  /** 演出・リプレイ・カメラを初期状態に */
  private resetView() {
    this.particles = [];
    this.rings = [];
    this.glints = [];
    this.rec = [];
    this.replay = null;
    this.pendingReplay = null;
    this.winnerFocus = 0;
    $('replay').hidden = true;
    const cam = this.cameras.main;
    cam.setZoom(BASE_ZOOM);
    cam.centerOn(ARENA.width / 2, ARENA.height / 2);
  }

  /** 参加者：届いた状態を写す */
  private applySnap(snap: Snap) {
    const now = performance.now() / 1000;
    this.snapPrev = this.snapCur;
    this.snapCur = { at: now, s: snap };
    for (const [id, sp] of snap.defs ?? []) this.specDefs.set(id, sp);
    if (snap.mp !== undefined && snap.mp !== this.cave?.seed) this.setCave(generateCave(snap.mp));
    if (snap.rd !== this.round) {
      // 新しいラウンド
      this.resetView();
      this.snapPrev = null;
      this.guestTrails.clear();
    }
    snap.seats.forEach((p, i) => {
      const a = this.actors[i];
      if (a && a.name !== p.name) {
        a.name = p.name;
        this.hudBuilt = false;
      }
    });
    this.state = snap.st;
    this.round = snap.rd;
    this.countdown = snap.cd;
    this.matchOver = snap.mo;
    this.roundWinner = snap.rw >= 0 ? this.actors[snap.rw] : null;
    this.simTime = snap.tm;
    snap.a.forEach((v, i) => {
      const a = this.actors[i];
      if (!a) return;
      [a.x, a.y] = [v[0], v[1]];
      if (a !== this.me) a.aim = v[2];
      a.alive = !!v[3];
      a.inv = v[4];
      a.hp = v[5];
      a.wins = v[6];
      const order = v[9];
      a.rot = { order: () => order, take: () => {} } as unknown as Rotation;
      a.ready = [0, 1, 2].map((b) => !!(v[10] & (1 << b)));
      a.slotRefill = v[11];
      a.stock = v[12];
    });
    if (snap.lo) {
      snap.lo.forEach((lo, i) => {
        const a = this.actors[i];
        if (!a) return;
        a.loadout = lo;
        a.specs = lo.map((lv, j) => buildSpec(lv, j));
      });
    }
    // 残像は届いた位置をつないで手元で作る
    const alive = new Set<number>();
    for (const sh of snap.s) {
      alive.add(sh[0]);
      const t = this.guestTrails.get(sh[0]) ?? [];
      t.push({ x: sh[1], y: sh[2] });
      if (t.length > TRAIL_LENGTH / 2) t.shift();
      this.guestTrails.set(sh[0], t);
    }
    for (const id of this.guestTrails.keys()) if (!alive.has(id)) this.guestTrails.delete(id);
    this.applyFx(snap.fx);
    this.pushRec(this.snapFrame(snap, snap, 1));

    // 結果とドラフトの画面
    if (snap.rs && $('shell-result').hidden) this.showResult();
    else if (!snap.rs) $('shell-result').hidden = true;
    if (snap.dr) {
      const d = snap.dr;
      this.draft = d.ids.map((id, i) => ({ id, takenBy: d.taken[i] >= 0 ? this.actors[d.taken[i]] : null }));
      this.draftOrder = d.order.map((i) => this.actors[i]);
      this.draftTurn = d.turn;
      this.draftLog = d.log;
      this.lastTaken = d.last;
      this.draftBusy = d.busy;
      if (this.draftSel !== null && (!this.isMyDraftTurn() || this.draft[this.draftSel]?.takenBy)) this.draftSel = null;
      const key = JSON.stringify(d) + this.draftSel;
      $('draft').hidden = false;
      if (key !== this.draftKey) {
        this.draftKey = key;
        this.renderDraft();
      }
    } else {
      $('draft').hidden = true;
      this.draftKey = '';
      this.draftSel = null;
    }
  }

  /** 参加者：ホストから届いた演出を手元で再生する */
  private applyFx(list: FxEvent[]) {
    for (const ev of list) {
      const n = (k: string) => Number(ev[k]) || 0;
      if (ev.e === 'b') this.burst(n('x'), n('y'), n('n'), n('c'), n('sp'), n('l'), n('r'), true);
      else if (ev.e === 'g') this.glints.push({ x: n('x'), y: n('y'), tx: n('tx'), ty: n('ty'), life: 0.28, color: n('c') });
      else if (ev.e === 'r') this.rings.push({ x: n('x'), y: n('y'), life: 0.3, color: n('c') });
      else if (ev.e === 'hit' && n('seat') === this.mySeat) {
        this.cameras.main.shake(160, 0.01);
      } else if (ev.e === 'rp') {
        const kill = ev.kill as Kill;
        const then = ev.then as 'live' | 'winner';
        if (then === 'winner') {
          if (this.replay) this.replay.then = 'winner';
          else if (this.pendingReplay) this.pendingReplay.then = 'winner';
          else this.pendingReplay = { t: 0.45, kill, then };
        } else if (kill.victim === this.mySeat) {
          this.pendingReplay = { t: 0.4, kill, then };
        }
      } else if (ev.e === 'fw') {
        this.focusWinner();
      }
    }
  }

  /** 参加者：2つの状態の間を alpha で補間して1コマ作る */
  private snapFrame(prev: Snap, cur: Snap, alpha: number): Frame {
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const prevShells = new Map(prev.s.map((sh) => [sh[0], sh]));
    const spec = (id: number) => this.specDefs.get(id) ?? SHELLS.normal;
    return {
      tm: lerp(prev.tm, cur.tm),
      actors: cur.a.map((c, i) => {
        const p = prev.a[i] ?? c;
        const sameOrbits = p[8].length === c[8].length;
        return {
          x: lerp(p[0], c[0]),
          y: lerp(p[1], c[1]),
          aim: i === this.mySeat && this.actors[i] ? this.actors[i].aim : c[2],
          alive: !!c[3],
          inv: c[4],
          hp: c[5],
          color: this.actors[i]?.color ?? 0xffffff,
          targeted: !!c[7],
          orbits: c[8].map((o, j) => ({
            x: sameOrbits ? lerp(p[8][j][0], o[0]) : o[0],
            y: sameOrbits ? lerp(p[8][j][1], o[1]) : o[1],
            spec: spec(o[2]),
            angle: o[3],
          })),
        };
      }),
      shells: cur.s.map((c) => {
        const p = prevShells.get(c[0]) ?? c;
        return {
          id: c[0],
          x: lerp(p[1], c[1]),
          y: lerp(p[2], c[2]),
          angle: c[3],
          spec: spec(c[4]),
          fade: c[5],
          ownerColor: this.actors[c[6]]?.color ?? 0xffffff,
          trail: this.guestTrails.get(c[0]) ?? [],
          live: { split: !!(c[7] & 1), pierce: !!(c[7] & 2), rebound: !!(c[7] & 4), homing: !!(c[7] & 8) },
        };
      }),
      particles: this.particles.map((p) => ({ x: p.x, y: p.y, r: p.r, color: p.color, a: Math.max(0, p.life / p.max) })),
      glints: this.glints.map((gl) => ({ x: gl.x, y: gl.y, tx: gl.tx, ty: gl.ty, k: gl.life / 0.28, color: gl.color })),
      rings: this.rings.map((r) => ({ x: r.x, y: r.y, k: r.life / 0.3, color: r.color })),
      crates: [],
      items: [],
    };
  }

  /** 今描く1コマ。参加者は届いた状態を補間する */
  private liveFrame(): Frame {
    if (this.role !== 'guest') return this.capture();
    const cur = this.snapCur;
    if (!cur) return { tm: 0, actors: [], shells: [], particles: [], glints: [], rings: [], crates: [], items: [] };
    const prev = this.snapPrev;
    if (!prev) return this.snapFrame(cur.s, cur.s, 1);
    const span = Math.max(1 / 60, cur.at - prev.at);
    const alpha = Math.min(1, (performance.now() / 1000 - cur.at) / span);
    return this.snapFrame(prev.s, cur.s, alpha);
  }

  /** 参加者の毎フレーム：操作を送り、届いた状態を描く */
  private guestUpdate(realDt: number) {
    const me = this.me;
    const ptr = this.input.activePointer;
    const ap = this.aimPoint();
    if (me && me.alive) me.aim = Math.atan2(ap.y - me.y, ap.x - me.x);
    this.inputAcc += realDt;
    if (me && this.inputAcc >= 1 / SNAP_HZ) {
      this.inputAcc = 0;
      let mx = 0;
      let my = 0;
      if (this.keys.A.isDown) mx -= 1;
      if (this.keys.D.isDown) mx += 1;
      if (this.keys.W.isDown) my -= 1;
      if (this.keys.S.isDown) my += 1;
      const fire = (ptr.leftButtonDown() || this.keys.SPACE.isDown) && !this.replay && this.state === 'play';
      this.net?.toHost({ k: 'input', mx, my, aim: r2(me.aim), fire });
    }
    this.updateReplay(realDt);
    this.updateParticles(realDt);
    this.renderIntro();
    this.hudTimer -= realDt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.renderHud();
      this.renderHand();
    }
    this.render();
  }

  // ---------------- ロビー ----------------

  /** 「オンライン対戦」ボタンとロビー画面をつなぐ */
  private bindLobby() {
    if (!this.online) return;
    $('online-btn').onclick = () => this.openLobby();
    $('lobby-enter').onclick = () => this.enterRoom();
    $('lobby-close').onclick = () => this.closeLobby();
    $('lobby-leave').onclick = () => this.leaveOnline();
    $('lobby-back').onclick = () => this.closeLobby();
    $('lobby-start').onclick = () => {
      if (this.net?.isHost) this.hostStartMatch();
    };
    $('lobby-copy').onclick = () => {
      const input = $('lobby-url') as HTMLInputElement;
      void navigator.clipboard?.writeText(input.value);
      $('lobby-copy').textContent = 'コピーしました';
    };
    this.renderOnlineButton();
  }

  private openLobby(room?: string) {
    const nameEl = $('lobby-name') as HTMLInputElement;
    const roomEl = $('lobby-room') as HTMLInputElement;
    if (!nameEl.value) nameEl.value = readLocal('tss-name') || `P${Math.floor(Math.random() * 900 + 100)}`;
    if (room) roomEl.value = room;
    if (!roomEl.value) roomEl.value = Math.random().toString(36).slice(2, 7);
    $('lobby').hidden = false;
    // 名前の入力中に WASD などをゲームに取られないようにする
    this.input.keyboard!.enabled = false;
    this.input.keyboard!.disableGlobalCapture();
    this.renderLobby();
  }

  private closeLobby() {
    $('lobby').hidden = true;
    this.input.keyboard!.enabled = true;
    this.input.keyboard!.enableGlobalCapture();
  }

  private enterRoom() {
    const name = ($('lobby-name') as HTMLInputElement).value.trim().slice(0, 12) || 'player';
    const room = ($('lobby-room') as HTMLInputElement).value.trim().toLowerCase();
    if (!ROOM_RE.test(room)) {
      this.lobbyMsg = '部屋の名前は半角の英小文字・数字・ハイフンで24文字まで';
      return this.renderLobby();
    }
    writeLocal('tss-name', name);
    this.net?.close();
    const net = new Net(room, name);
    this.net = net;
    this.lobbyMsg = '';
    net.onRoom = () => this.onRoom();
    net.onPeer = (from, d) => this.onPeer(from, d);
    net.onHost = (d) => this.onHostMsg(d);
    net.onClose = (reason) => {
      this.lobbyMsg = reason;
      this.leaveOnline(true);
    };
    const url = new URL(location.href);
    url.searchParams.set('r', room);
    history.replaceState(null, '', url);
    this.renderLobby();
  }

  /** 部屋を出て、ひとりで遊ぶ状態に戻る */
  private leaveOnline(keepLobbyOpen = false) {
    this.net?.close();
    this.net = null;
    this.role = 'offline';
    this.actors.forEach((a, i) => Object.assign(a, { ctrl: i === 0 ? 'local' : 'bot', bot: i > 0, pid: null, name: OFFLINE_NAMES[i] }));
    this.mySeat = 0;
    const url = new URL(location.href);
    url.searchParams.delete('r');
    history.replaceState(null, '', url);
    this.resetView();
    this.resetMatch();
    if (keepLobbyOpen) this.openLobby();
    else this.closeLobby();
    this.renderOnlineButton();
  }

  /** 対戦をやめて部屋の待機画面に戻る（ホストが抜けたときなど） */
  private toLobby() {
    this.role = 'offline';
    this.actors.forEach((a, i) => Object.assign(a, { ctrl: i === 0 ? 'local' : 'bot', bot: i > 0, pid: null, name: OFFLINE_NAMES[i] }));
    this.mySeat = 0;
    this.resetView();
    this.resetMatch();
    this.openLobby();
  }

  private renderLobby() {
    if (!this.online) return;
    const net = this.net;
    $('lobby-join').hidden = !!net;
    $('lobby-room-view').hidden = !net;
    $('lobby-msg').textContent = this.lobbyMsg;
    $('lobby-msg').hidden = !this.lobbyMsg;
    if (!net) return;
    $('lobby-title').textContent = `部屋「${net.room}」`;
    $('lobby-players').innerHTML =
      Array.from({ length: MAX_PLAYERS }, (_, i) => {
        const p = net.players[i];
        if (!p) return `<li class="empty" style="--c:${hex(COLORS[i])}">空き（CPU が入る）</li>`;
        const tags = [p.id === net.host ? '<b>ホスト</b>' : '', p.id === net.you ? '<b>あなた</b>' : ''].join('');
        return `<li style="--c:${hex(COLORS[i])}"><span>${escapeHtml(p.name)}</span>${tags}</li>`;
      }).join('') + (net.players.length > MAX_PLAYERS ? '<li class="empty">満員のため観戦</li>' : '');
    const url = new URL(location.href);
    url.searchParams.set('r', net.room);
    ($('lobby-url') as HTMLInputElement).value = url.toString();
    const inMatch = this.role === 'host' || this.role === 'guest';
    const start = $('lobby-start') as HTMLButtonElement;
    start.hidden = !net.isHost || inMatch;
    $('lobby-wait').hidden = net.isHost || inMatch || !net.open;
    $('lobby-wait').textContent = net.inMatch ? '対戦中です。次の試合から参加できます（今は観戦）' : 'ホストが開始するのを待っています…';
    $('lobby-back').hidden = !inMatch;
  }

  private renderOnlineButton() {
    if (!this.online) return;
    const btn = $('online-btn');
    btn.textContent = this.net ? `部屋「${this.net.room}」` : 'オンライン対戦';
    btn.classList.toggle('on', !!this.net);
  }

  // ---------------- デバッグ ----------------

  /** カスタム甲羅のデバッグウィンドウ：自分の甲羅1〜3に効果を好きなだけ積む。変更はすぐ反映 */
  private renderDebug() {
    const el = $('shell-debug');
    el.hidden = !(this.custom && this.debugOpen && this.role === 'offline' && this.me);
    if (el.hidden) return;
    const me = this.me!;
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
      this.loVer++;
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
      ['pizza', 'ピザで表示'],
    ] as const) {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.debug[key];
      cb.onchange = () => {
        this.debug[key] = cb.checked;
        cb.blur();
        // 見た目の切り替えは上下の表示も描き直す
        this.hudBuilt = false;
        this.handKey = '';
      };
      l.append(cb, ` ${label}`);
      opts.appendChild(l);
    }
    if (this.craft)
      opts.appendChild(
        btn('足元に素材を4種類出す', () => {
          MATERIAL_IDS.forEach((kind, i) => {
            const a = (i / 4) * Math.PI * 2;
            this.items.push({ id: ++this.itemSeq, kind, x: me.x + Math.cos(a) * 70, y: me.y + Math.sin(a) * 70, vx: 0, vy: 0, age: 0.3 });
          });
        }),
      );
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

  /** セル・オートマトンの洞窟（カスタム甲羅）。null なら柱の試合場 */
  private cave: CaveMap | null = null;
  private walls: WallGrid | null = null;
  private arenaBg!: Phaser.GameObjects.Graphics;

  private setCave(cave: CaveMap) {
    this.cave = cave;
    this.walls = { solid: cave.solid, cols: COLS, rows: ROWS, cell: CAVE.cell };
    setArena([], this.walls);
    this.drawArena();
  }

  private drawArena() {
    const bg = this.arenaBg;
    if (!bg) return;
    bg.clear();
    bg.fillStyle(0x10141c, 1);
    bg.fillRect(0, 0, ARENA.width, ARENA.height);
    bg.lineStyle(1, 0x1b2230, 1);
    for (let x = L; x <= R; x += 40) bg.lineBetween(x, T, x, B);
    for (let y = T; y <= B; y += 40) bg.lineBetween(L, y, R, y);
    bg.fillStyle(0x2a3346, 1);
    bg.fillRect(0, 0, ARENA.width, T);
    bg.fillRect(0, B, ARENA.width, ARENA.height - B);
    bg.fillRect(0, 0, L, ARENA.height);
    bg.fillRect(R, 0, ARENA.width - R, ARENA.height);
    const cave = this.cave;
    if (!cave) for (const p of PILLARS) bg.fillRect(p.x, p.y, p.w, p.h);
    bg.lineStyle(2, 0x5a6b8f, 1);
    bg.strokeRect(L, T, R - L, B - T);
    if (!cave) {
      for (const p of PILLARS) bg.strokeRect(p.x, p.y, p.w, p.h);
      return;
    }
    // 洞窟：壁のマスを塗り、床と接する辺だけ縁取る（つながった壁が1つの塊に見えるように）
    const n = CAVE.cell;
    const wall = (c: number, r: number) => c >= 0 && c < COLS && r >= 0 && r < ROWS && cave.solid[r * COLS + c] === 1;
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) if (wall(c, r)) bg.fillRect(L + c * n, T + r * n, n, n);
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        if (!wall(c, r)) continue;
        const x = L + c * n;
        const y = T + r * n;
        if (r > 0 && !wall(c, r - 1)) bg.lineBetween(x, y, x + n, y);
        if (r < ROWS - 1 && !wall(c, r + 1)) bg.lineBetween(x, y + n, x + n, y + n);
        if (c > 0 && !wall(c - 1, r)) bg.lineBetween(x, y, x, y + n);
        if (c < COLS - 1 && !wall(c + 1, r)) bg.lineBetween(x + n, y, x + n, y + n);
      }
  }

  /** 今の状態を描画用に写す */
  private capture(): Frame {
    const targeted = new Set(this.shells.filter((s) => !s.dead && s.target && !s.homingOff).map((s) => s.target!));
    return {
      tm: this.simTime,
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
          id: s.id,
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
      crates: this.crates.filter((c) => c.respawn <= 0).map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, hp: c.hp, shake: c.shake })),
      items: this.items.map((it) => ({ x: it.x, y: it.y, kind: it.kind, age: it.age })),
    };
  }

  private render() {
    const g = this.g;
    g.clear();
    this.fx.clear();
    // リプレイ中は録画を、それ以外は今の状態を描く
    const frame = this.replay ? this.replayFrame() : this.liveFrame();
    this.pizzaUsed = 0;
    this.drawFrame(frame);
    for (let i = this.pizzaUsed; i < this.pizzaPool.length; i++) this.pizzaPool[i].setVisible(false);
    if (this.replay) {
      this.label.setText('');
      return;
    }

    const me = this.me;
    if (this.state === 'countdown') {
      // 3・2・1 は renderIntro が出す
    } else if (me && !me.alive && this.state === 'play')
      this.label
        .setText(this.role !== 'offline' ? '脱落… 観戦中' : this.drafting ? (this.fast ? '早送り中（R で戻す）' : '脱落… R で早送り') : '脱落… R で次のラウンド')
        .setFontSize(28);
    else this.label.setText('').setFontSize(48);

    if (this.debug.hitbox) this.drawHitboxes();

    const ap = this.aimPoint();
    g.lineStyle(2, 0xffffff, 0.85);
    g.strokeCircle(ap.x, ap.y, 9);
    g.lineBetween(ap.x - 15, ap.y, ap.x - 5, ap.y);
    g.lineBetween(ap.x + 5, ap.y, ap.x + 15, ap.y);
    g.lineBetween(ap.x, ap.y - 15, ap.x, ap.y - 5);
    g.lineBetween(ap.x, ap.y + 5, ap.x, ap.y + 15);
  }

  /** 落ちている素材を1つ描く（下に影と色の輪） */
  private drawMaterial(kind: Material, x: number, y: number) {
    const g = this.g;
    const col = MATERIALS[kind].color;
    g.fillStyle(0x000000, 0.35);
    g.fillEllipse(x, y + 11, 18, 6);
    g.lineStyle(2, col, 0.5);
    g.strokeCircle(x, y, 13);
    if (kind === 'feather') {
      g.fillStyle(0xe8f4ff, 1);
      g.fillTriangle(x - 8, y + 8, x + 8, y - 9, x + 2, y + 3);
      g.fillTriangle(x - 8, y + 8, x + 8, y - 9, x - 3, y - 2);
      g.lineStyle(1.5, 0x8fa6bf, 1);
      g.lineBetween(x - 9, y + 9, x + 6, y - 6);
    } else if (kind === 'eye') {
      g.fillStyle(0xffffff, 1);
      g.fillCircle(x, y, 8);
      g.fillStyle(0xe8453c, 1);
      g.fillCircle(x + 1.5, y, 4.5);
      g.fillStyle(0x111111, 1);
      g.fillCircle(x + 2, y, 2);
    } else if (kind === 'stone') {
      g.fillStyle(0x9aa3b5, 1);
      g.fillPoints([new Phaser.Math.Vector2(x - 8, y + 4), new Phaser.Math.Vector2(x - 5, y - 6), new Phaser.Math.Vector2(x + 4, y - 8), new Phaser.Math.Vector2(x + 9, y - 1), new Phaser.Math.Vector2(x + 6, y + 7), new Phaser.Math.Vector2(x - 3, y + 8)], true);
      g.fillStyle(0xc9d0dc, 1);
      g.fillCircle(x - 2, y - 3, 2.5);
    } else {
      g.lineStyle(2.5, 0xffd166, 1);
      g.beginPath();
      g.moveTo(x - 6, y + 8);
      for (let i = 0; i < 5; i++) g.lineTo(i % 2 === 0 ? x + 6 : x - 6, y + 5 - i * 3.5);
      g.lineTo(x + 6, y - 9);
      g.strokePath();
    }
  }

  private drawFrame(f: Frame) {
    const g = this.g;

    // 箱：木の色の四角に板の線。傷ついたらひびを入れ、当たった瞬間は揺らす
    for (const c of f.crates) {
      const j = c.shake > 0 ? Math.sin(c.shake * 120) * 2 : 0;
      const x = c.x + j;
      g.fillStyle(0x8a5a2b, 1);
      g.fillRect(x, c.y, c.w, c.h);
      g.fillStyle(0xb07a3e, 1);
      g.fillRect(x + 3, c.y + 3, c.w - 6, c.h - 6);
      g.lineStyle(3, 0x8a5a2b, 1);
      g.lineBetween(x + 4, c.y + 4, x + c.w - 4, c.y + c.h - 4);
      g.lineBetween(x + c.w - 4, c.y + 4, x + 4, c.y + c.h - 4);
      if (c.hp < CRAFT.crateHp) {
        g.lineStyle(2, 0x3a2410, 1);
        g.lineBetween(x + c.w * 0.3, c.y + 2, x + c.w * 0.45, c.y + c.h * 0.5);
        g.lineBetween(x + c.w * 0.45, c.y + c.h * 0.5, x + c.w * 0.35, c.y + c.h - 2);
      }
    }
    // 素材：ふわふわ浮かせる
    for (const it of f.items) this.drawMaterial(it.kind, it.x, it.y + Math.sin(it.age * 5) * 2);

    // 甲羅：残像 → 本体（色の円に白い縁）。分裂前は「V」、反発が残っていれば外側に輪、中心に投げた人の色
    for (const s of f.shells) {
      s.trail.forEach((p, i) => {
        const k = (i + 1) / (s.trail.length + 1);
        g.fillStyle(s.spec.color, 0.35 * k * s.fade);
        g.fillCircle(p.x, p.y, s.spec.radius * (0.35 + 0.55 * k));
      });
      if (this.drawPizza(s.x, s.y, s.spec.radius, s.spec, (performance.now() / 1000) * 9 + s.id, s.fade, false)) continue;
      g.fillStyle(s.spec.color, s.fade);
      g.fillCircle(s.x, s.y, s.spec.radius);
      g.lineStyle(s.spec.heavy ? 3 : 2, 0xeaffea, s.fade);
      g.strokeCircle(s.x, s.y, s.spec.radius);
      if (s.live.rebound) {
        g.lineStyle(1.5, 0xffffff, 0.7 * s.fade);
        g.strokeCircle(s.x, s.y, s.spec.radius + 4);
      }
      if (s.live.split) {
        g.lineStyle(2, 0xffffff, 0.9);
        for (const side of [-1, 1]) {
          g.lineBetween(s.x - Math.cos(s.angle) * 5, s.y - Math.sin(s.angle) * 5, s.x + Math.cos(s.angle + side * 0.8) * 7, s.y + Math.sin(s.angle + side * 0.8) * 7);
        }
      }
      g.fillStyle(s.ownerColor, 1);
      g.fillCircle(s.x, s.y, 3);
    }
    for (const r of f.rings) {
      g.lineStyle(3, r.color, r.k);
      g.strokeCircle(r.x, r.y, 10 + (1 - r.k) * 30);
    }

    // キャラ：色の円と照準の線、頭上に残りHP
    for (const a of f.actors) {
      if (!a.alive) continue;
      // 周回している手持ちの甲羅（無敵中の点滅でも消さない）
      for (const o of a.orbits) this.drawOrbitShell(o.x, o.y, o.spec, o.angle);
      const blink = a.inv > 0 && Math.floor(a.inv * 16) % 2 === 0;
      if (blink) continue;
      g.lineStyle(6, a.color, 0.7);
      g.lineBetween(a.x, a.y, a.x + Math.cos(a.aim) * (SHELL.actorRadius + 8), a.y + Math.sin(a.aim) * (SHELL.actorRadius + 8));
      g.fillStyle(a.color, 1);
      g.fillCircle(a.x, a.y, SHELL.actorRadius);
      g.fillStyle(0x0a0d13, 0.6);
      g.fillCircle(a.x, a.y, SHELL.actorRadius * 0.4);
      for (let i = 0; i < SHELL.hp; i++) {
        g.fillStyle(i < a.hp ? 0xff6b81 : 0x333a48, 1);
        g.fillCircle(a.x - (SHELL.hp - 1) * 5 + i * 10, a.y - SHELL.actorRadius - 10, 3.5);
      }
    }

    for (const p of f.particles) {
      g.fillStyle(p.color, p.a);
      g.fillCircle(p.x, p.y, p.r);
    }
  }
}
