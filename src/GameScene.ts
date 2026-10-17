import * as Phaser from 'phaser';
import { ABILITIES, ABILITY_BY_ID, emptyBuild, statsFor, type AbilityId, type Build, type BulletStats } from './abilities';
import { ARENA, ENEMY_KINDS, LIMITS, PIXEL, PLAYER, SPAWN, xpToNext, type EnemyKind } from './config';
import { ui, type Choice } from './ui';

const L = ARENA.wall;
const R = ARENA.width - ARENA.wall;
const T = ARENA.wall;
const B = ARENA.height - ARENA.wall;

/** 分裂の世代ごとの色（どこから分かれた弾か一目で分かるように） */
const GEN_COLORS = [0x6ef2ff, 0x8dff7a, 0xffe066, 0xff8ad8, 0xff6b6b, 0xffffff];

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bouncesLeft: number;
  pierceLeft: number;
  splitLeft: number;
  life: number;
  maxLife: number;
  dmg: number;
  /** 0: 親弾 / 1: 反射分裂の子弾 / 2: 命中拡散の破片 */
  gen: number;
  shotId: number;
  hit: Set<Enemy>;
  dead: boolean;
}

interface Enemy {
  kind: EnemyKind;
  x: number;
  y: number;
  r: number;
  hp: number;
  maxHp: number;
  speed: number;
  kx: number;
  ky: number;
  flash: number;
  dead: boolean;
}

interface Pending {
  kind: EnemyKind;
  x: number;
  y: number;
  t: number;
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

interface ChainPopup {
  text: Phaser.GameObjects.Text;
  count: number;
  life: number;
}

interface Blast {
  x: number;
  y: number;
  r: number;
  t: number;
  shotId: number;
  /** 何段目の連鎖か（弾で倒した敵の爆発が0） */
  depth: number;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  life: number;
}

const BLAST_DELAY = 0.09; // 誘爆の連鎖が目で追えるように少し遅らせる
const RING_LIFE = 0.3;

type State = 'play' | 'levelup' | 'paused' | 'dead';

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class GameScene extends Phaser.Scene {
  private g!: Phaser.GameObjects.Graphics;
  private keys!: Record<'W' | 'A' | 'S' | 'D' | 'SPACE', Phaser.Input.Keyboard.Key>;

  private state: State = 'play';
  private build: Build = emptyBuild();
  private stats: BulletStats = statsFor(this.build);
  private player = { x: 0, y: 0, hp: 0, inv: 0, aim: 0, cooldown: 0 };
  private bullets: Bullet[] = [];
  private enemies: Enemy[] = [];
  private pending: Pending[] = [];
  private particles: Particle[] = [];
  private blasts: Blast[] = [];
  private rings: Ring[] = [];
  private chains = new Map<number, ChainPopup>();
  private shotSeq = 0;
  private spawnTimer = 0;
  private elapsed = 0;
  private level = 1;
  private xp = 0;
  private kills = 0;
  private hudTimer = 0;
  private record = { bestChain: 0, maxBullets: 0 };

  private debug = { invincible: false, noSpawn: false };

  constructor() {
    super('game');
  }

  create() {
    // 画面は ARENA の 1/PIXEL の解像度なので、カメラで縮めて全体を映す
    this.cameras.main.setZoom(1 / PIXEL).centerOn(ARENA.width / 2, ARENA.height / 2);
    this.drawArena();
    this.g = this.add.graphics().setDepth(10);
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,SPACE') as GameScene['keys'];
    this.input.keyboard!.addCapture('TAB');
    this.input.keyboard!.on('keydown-TAB', () => ui.toggleDebug());
    this.input.keyboard!.on('keydown-ESC', () => this.togglePause());
    ui.menuClose = () => this.togglePause();
    this.input.mouse?.disableContextMenu();
    // モード切替で戻ってきたとき、ポーズ表示をこのモードの状態に合わせる
    this.events.on('wake', () => {
      ui.menuClose = () => this.togglePause();
      ui.setPaused(this.state === 'paused');
    });

    ui.setupDebug({
      getBuild: () => this.build,
      setLevel: (id, lv) => {
        this.build[id] = lv;
        this.onBuildChanged();
      },
      toggles: [
        { label: '無敵', get: () => this.debug.invincible, set: (v) => (this.debug.invincible = v) },
        { label: '敵の出現を止める', get: () => this.debug.noSpawn, set: (v) => (this.debug.noSpawn = v) },
      ],
      actions: [
        { label: '雑魚を20体出す', run: () => this.spawnBurst(20) },
        { label: '敵を全消去', run: () => (this.enemies = []) },
        { label: 'レベルアップ', run: () => (this.xp = xpToNext(this.level)) },
        { label: '能力リセット', run: () => ((this.build = emptyBuild()), this.onBuildChanged()) },
      ],
    });

    this.reset();
  }

  private reset() {
    this.state = 'play';
    this.build = emptyBuild();
    this.onBuildChanged();
    this.player = { x: ARENA.width / 2, y: ARENA.height / 2, hp: PLAYER.maxHp, inv: 0, aim: 0, cooldown: 0 };
    this.bullets = [];
    this.enemies = [];
    this.pending = [];
    this.particles = [];
    this.blasts = [];
    this.rings = [];
    for (const c of this.chains.values()) c.text.destroy();
    this.chains.clear();
    this.spawnTimer = 1;
    this.elapsed = 0;
    this.level = 1;
    this.xp = 0;
    this.kills = 0;
    this.record = { bestChain: 0, maxBullets: 0 };
    ui.setPaused(false);
  }

  private onBuildChanged() {
    this.stats = statsFor(this.build);
    ui.build(this.build);
  }

  private togglePause() {
    if (this.state === 'play') this.state = 'paused';
    else if (this.state === 'paused') this.state = 'play';
    ui.setPaused(this.state === 'paused');
  }

  update(_time: number, deltaMs: number) {
    const dt = Math.min(deltaMs / 1000, 1 / 30);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      ui.hud({
        level: this.level,
        xp: this.xp,
        need: xpToNext(this.level),
        hp: this.player.hp,
        maxHp: PLAYER.maxHp,
        time: this.elapsed,
        kills: this.kills,
        bullets: this.bullets.length,
        enemies: this.enemies.length,
      });
    }

    if (this.state === 'play') {
      this.elapsed += dt;
      this.updatePlayer(dt);
      this.updateSpawns(dt);
      this.updateEnemies(dt);
      this.updateBullets(dt);
      this.updateBlasts(dt);
      this.updateParticles(dt);
      this.updateChains(dt);
      this.record.maxBullets = Math.max(this.record.maxBullets, this.bullets.length);
      this.checkLevelUp();
    } else {
      // 照準だけは止まっていても追従させる
      this.updateAim();
    }
    this.render();
  }

  // ---------------- プレイヤー ----------------

  private updateAim() {
    const p = this.input.activePointer;
    this.player.aim = Math.atan2(p.worldY - this.player.y, p.worldX - this.player.x);
  }

  private updatePlayer(dt: number) {
    const pl = this.player;
    let mx = 0;
    let my = 0;
    if (this.keys.A.isDown) mx -= 1;
    if (this.keys.D.isDown) mx += 1;
    if (this.keys.W.isDown) my -= 1;
    if (this.keys.S.isDown) my += 1;
    const len = Math.hypot(mx, my) || 1;
    pl.x = Phaser.Math.Clamp(pl.x + (mx / len) * PLAYER.speed * dt, L + PLAYER.radius, R - PLAYER.radius);
    pl.y = Phaser.Math.Clamp(pl.y + (my / len) * PLAYER.speed * dt, T + PLAYER.radius, B - PLAYER.radius);
    pl.inv = Math.max(0, pl.inv - dt);
    this.updateAim();

    pl.cooldown -= dt;
    const firing = this.input.activePointer.leftButtonDown() || this.keys.SPACE.isDown;
    if (firing && pl.cooldown <= 0 && !ui.isModalOpen()) {
      this.fire();
      pl.cooldown = this.stats.fireInterval;
    }
  }

  private fire() {
    const s = this.stats;
    const pl = this.player;
    const shotId = ++this.shotSeq;
    for (let i = 0; i < s.ways; i++) {
      const a = pl.aim + (i - (s.ways - 1) / 2) * s.spread;
      const x = pl.x + Math.cos(pl.aim) * (PLAYER.radius + 4);
      const y = pl.y + Math.sin(pl.aim) * (PLAYER.radius + 4);
      this.addBullet({
        x,
        y,
        vx: Math.cos(a) * s.speed,
        vy: Math.sin(a) * s.speed,
        bouncesLeft: s.bounces,
        pierceLeft: s.pierce,
        splitLeft: s.splitDepth,
        life: s.life,
        maxLife: s.life,
        dmg: s.damage,
        gen: 0,
        shotId,
        hit: new Set(),
        dead: false,
      });
    }
    const mx = pl.x + Math.cos(pl.aim) * (PLAYER.radius + 6);
    const my = pl.y + Math.sin(pl.aim) * (PLAYER.radius + 6);
    this.burst(mx, my, 3, 0xbff8ff, 120, 0.12, 2);
  }

  private addBullet(b: Bullet) {
    if (this.bullets.length >= LIMITS.bullets) return false;
    this.bullets.push(b);
    return true;
  }

  private hurtPlayer(from: Enemy) {
    const pl = this.player;
    if (pl.inv > 0 || this.debug.invincible) return;
    pl.hp -= 1;
    pl.inv = PLAYER.invincible;
    this.cameras.main.shake(180, 0.01);
    this.burst(pl.x, pl.y, 14, 0xffffff, 260, 0.35, 3);
    // 当たった敵と周囲を押し返す
    for (const e of this.enemies) {
      const dx = e.x - pl.x;
      const dy = e.y - pl.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < 120 || e === from) {
        e.kx += (dx / d) * 500;
        e.ky += (dy / d) * 500;
      }
    }
    if (pl.hp <= 0) this.gameOver();
  }

  private gameOver() {
    this.state = 'dead';
    this.burst(this.player.x, this.player.y, 40, 0xffffff, 400, 0.8, 4);
    const m = Math.floor(this.elapsed / 60);
    const s = Math.floor(this.elapsed % 60).toString().padStart(2, '0');
    const owned = ABILITIES.filter((a) => this.build[a.id] > 0)
      .map((a) => `${a.name} Lv${this.build[a.id]}`)
      .join(' / ');
    ui.showGameOver(
      [
        ['生存時間', `${m}:${s}`],
        ['レベル', `${this.level}`],
        ['撃破数', `${this.kills}`],
        ['最大チェイン（1射での撃破数）', `${this.record.bestChain}`],
        ['最大同時弾数', `${this.record.maxBullets}`],
        ['ビルド', owned || 'なし'],
      ],
      () => this.reset(),
    );
  }

  // ---------------- 敵 ----------------

  private updateSpawns(dt: number) {
    if (!this.debug.noSpawn) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = SPAWN.interval(this.elapsed);
        const n = SPAWN.batch(this.elapsed);
        for (let i = 0; i < n; i++) this.queueSpawn(SPAWN.pickKind(this.elapsed));
      }
    }
    for (const p of this.pending) {
      p.t -= dt;
      if (p.t <= 0) this.spawnEnemy(p.kind, p.x, p.y);
    }
    this.pending = this.pending.filter((p) => p.t > 0);
  }

  private queueSpawn(kind: EnemyKind) {
    if (this.enemies.length + this.pending.length >= SPAWN.maxEnemies) return;
    const r = ENEMY_KINDS[kind].r;
    let x = 0;
    let y = 0;
    for (let i = 0; i < 12; i++) {
      x = Phaser.Math.Between(L + r, R - r);
      y = Phaser.Math.Between(T + r, B - r);
      if (Math.hypot(x - this.player.x, y - this.player.y) > SPAWN.minDistFromPlayer) break;
    }
    this.pending.push({ kind, x, y, t: SPAWN.telegraph });
  }

  private spawnBurst(n: number) {
    for (let i = 0; i < n; i++) this.queueSpawn('grunt');
  }

  private spawnEnemy(kind: EnemyKind, x: number, y: number) {
    const k = ENEMY_KINDS[kind];
    // 整数に丸める（小数のままだと序盤の雑魚がわずかなHP残りで1発で倒れなくなる）
    const hp = Math.max(1, Math.round(k.hp * SPAWN.hpScale(this.elapsed)));
    this.enemies.push({ kind, x, y, r: k.r, hp, maxHp: hp, speed: k.speed, kx: 0, ky: 0, flash: 0, dead: false });
  }

  private updateEnemies(dt: number) {
    const pl = this.player;
    const es = this.enemies;
    const damp = Math.exp(-8 * dt);
    for (const e of es) {
      const dx = pl.x - e.x;
      const dy = pl.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      e.x += ((dx / d) * e.speed + e.kx) * dt;
      e.y += ((dy / d) * e.speed + e.ky) * dt;
      e.kx *= damp;
      e.ky *= damp;
      e.flash = Math.max(0, e.flash - dt);
    }
    // 重なりを押し広げる
    for (let i = 0; i < es.length; i++) {
      const a = es[i];
      for (let j = i + 1; j < es.length; j++) {
        const b = es[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const min = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) / 2;
        a.x -= (dx / d) * push;
        a.y -= (dy / d) * push;
        b.x += (dx / d) * push;
        b.y += (dy / d) * push;
      }
    }
    for (const e of es) {
      e.x = Phaser.Math.Clamp(e.x, L + e.r, R - e.r);
      e.y = Phaser.Math.Clamp(e.y, T + e.r, B - e.r);
      if (Math.hypot(e.x - pl.x, e.y - pl.y) < e.r + PLAYER.radius) this.hurtPlayer(e);
    }
  }

  /** dx, dy はノックバック方向（正規化不要） */
  /** blastDepth は爆発による攻撃のとき、その爆発の連鎖段数 */
  private damageEnemy(e: Enemy, dmg: number, dx: number, dy: number, shotId: number, blastDepth = -1) {
    e.hp -= dmg;
    e.flash = 0.08;
    const d = Math.hypot(dx, dy) || 1;
    const kb = e.kind === 'tank' ? 60 : 160;
    e.kx += (dx / d) * kb;
    e.ky += (dy / d) * kb;
    if (e.hp <= 0 && !e.dead) {
      e.dead = true;
      this.kills++;
      this.xp += ENEMY_KINDS[e.kind].xp;
      this.burst(e.x, e.y, e.kind === 'tank' ? 26 : 12, ENEMY_KINDS[e.kind].color, 260, 0.45, 3);
      this.countChain(shotId, e.x, e.y);
      const { explodeRadius: er, explodeChain } = this.stats;
      const depth = blastDepth + 1;
      if (er > 0 && depth <= explodeChain) this.blasts.push({ x: e.x, y: e.y, r: er + e.r, t: BLAST_DELAY, shotId, depth });
    }
  }

  private updateBlasts(dt: number) {
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);
    if (this.blasts.length === 0) return;
    const ready: Blast[] = [];
    for (const b of this.blasts) {
      b.t -= dt;
      if (b.t <= 0) ready.push(b);
    }
    this.blasts = this.blasts.filter((b) => b.t > 0);
    for (const bl of ready) {
      this.rings.push({ x: bl.x, y: bl.y, r: bl.r, life: RING_LIFE });
      this.burst(bl.x, bl.y, 10, 0xffa040, 220, 0.3, 3);
      for (const e of this.enemies) {
        if (e.dead) continue;
        const dx = e.x - bl.x;
        const dy = e.y - bl.y;
        const rr = bl.r + e.r;
        if (dx * dx + dy * dy <= rr * rr) this.damageEnemy(e, this.stats.explodeDamage, dx, dy, bl.shotId, bl.depth);
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  // 1回の射撃（分裂した子弾を含む）で何体倒したか
  private countChain(shotId: number, x: number, y: number) {
    let c = this.chains.get(shotId);
    if (!c) {
      c = {
        count: 0,
        life: 0,
        text: this.add
          .text(x, y, '', { fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold', color: '#ffe066', stroke: '#000', strokeThickness: 4 })
          .setOrigin(0.5)
          .setDepth(20)
          .setVisible(false),
      };
      this.chains.set(shotId, c);
    }
    c.count++;
    c.life = 1.2;
    this.record.bestChain = Math.max(this.record.bestChain, c.count);
    if (c.count >= 3) {
      c.text.setText(`${c.count} CHAIN`).setPosition(x, y - 20).setVisible(true).setAlpha(1);
      c.text.setScale(1 + Math.min(1, c.count / 20));
    }
  }

  private updateChains(dt: number) {
    for (const [id, c] of this.chains) {
      c.life -= dt;
      c.text.y -= 20 * dt;
      c.text.setAlpha(Math.min(1, c.life / 0.4));
      if (c.life <= 0) {
        c.text.destroy();
        this.chains.delete(id);
      }
    }
  }

  // ---------------- 弾 ----------------

  private updateBullets(dt: number) {
    const s = this.stats;
    const live = this.enemies.filter((e) => !e.dead);
    for (const b of this.bullets) {
      if (b.dead) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.dead = true;
        continue;
      }

      let ang = Math.atan2(b.vy, b.vx);
      if (s.homingTurn > 0) {
        const target = this.nearestEnemy(b, live, s.homingRange);
        if (target) {
          const diff = wrapAngle(Math.atan2(target.y - b.y, target.x - b.x) - ang);
          ang += Phaser.Math.Clamp(diff, -s.homingTurn * dt, s.homingTurn * dt);
        }
      }
      // 高速化は撃った後の弾にも反映する
      b.vx = Math.cos(ang) * s.speed;
      b.vy = Math.sin(ang) * s.speed;

      // 高速な弾が敵をすり抜けないように細かく刻む
      const dist = s.speed * dt;
      const steps = Math.max(1, Math.ceil(dist / 8));
      const sdt = dt / steps;
      for (let i = 0; i < steps && !b.dead; i++) {
        b.x += b.vx * sdt;
        b.y += b.vy * sdt;
        this.bulletWalls(b, s);
        if (!b.dead) this.bulletEnemies(b, s, live);
      }
    }
    this.bullets = this.bullets.filter((b) => !b.dead);
    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  private radiusOf(b: Bullet) {
    const base = b.gen === 2 ? this.stats.radius * 0.55 : b.gen === 1 ? this.stats.radius * 0.7 : this.stats.radius;
    // 反射チャージで威力が上がった弾は大きく見せる
    return base * Math.min(1.8, 1 + (b.dmg - this.stats.damage) * 0.15);
  }

  private nearestEnemy(b: Bullet, live: Enemy[], range: number) {
    let best: Enemy | null = null;
    let bestD = range * range;
    for (const e of live) {
      if (e.dead || b.hit.has(e)) continue;
      const d = (e.x - b.x) ** 2 + (e.y - b.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private bulletWalls(b: Bullet, s: BulletStats) {
    const r = this.radiusOf(b);
    let hit = false;
    if (b.x - r < L) {
      b.x = L + r;
      b.vx = Math.abs(b.vx);
      hit = true;
    } else if (b.x + r > R) {
      b.x = R - r;
      b.vx = -Math.abs(b.vx);
      hit = true;
    }
    if (b.y - r < T) {
      b.y = T + r;
      b.vy = Math.abs(b.vy);
      hit = true;
    } else if (b.y + r > B) {
      b.y = B - r;
      b.vy = -Math.abs(b.vy);
      hit = true;
    }
    if (!hit) return;

    const color = GEN_COLORS[Math.min(b.gen, GEN_COLORS.length - 1)];
    if (b.bouncesLeft <= 0) {
      b.dead = true;
      this.burst(b.x, b.y, 5, color, 140, 0.2, 2);
      return;
    }
    b.bouncesLeft--;
    b.dmg += s.chargePerBounce;
    this.burst(b.x, b.y, 3, color, 100, 0.15, 2);

    // 分裂するのは親弾だけ。子弾は分裂も反射もせず短時間で消えるので、弾数は掛け算でなく足し算で増える
    if (b.splitLeft > 0) {
      const a = Math.atan2(b.vy, b.vx);
      const side = b.splitLeft % 2 === 0 ? 1 : -1;
      b.splitLeft--;
      this.addBullet({
        ...b,
        vx: Math.cos(a + side * s.splitAngle) * s.speed,
        vy: Math.sin(a + side * s.splitAngle) * s.speed,
        bouncesLeft: 0,
        splitLeft: 0,
        gen: 1,
        life: Math.min(b.life, s.childLife),
        maxLife: Math.min(b.life, s.childLife),
        pierceLeft: s.pierce,
        hit: new Set(b.hit),
      });
      this.burst(b.x, b.y, 6, GEN_COLORS[1], 180, 0.25, 2.5);
    }
  }

  private bulletEnemies(b: Bullet, s: BulletStats, live: Enemy[]) {
    for (const e of live) {
      if (e.dead || b.hit.has(e)) continue;
      const rr = this.radiusOf(b) + e.r;
      if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 > rr * rr) continue;
      b.hit.add(e);
      this.burst(b.x, b.y, 4, GEN_COLORS[Math.min(b.gen, GEN_COLORS.length - 1)], 160, 0.18, 2);
      this.damageEnemy(e, b.dmg, b.vx, b.vy, b.shotId);
      if (b.gen === 0 && s.shards > 0) this.shatter(b, e, s);
      if (b.pierceLeft <= 0) {
        b.dead = true;
        return;
      }
      b.pierceLeft--;
    }
  }

  // 命中拡散：親弾が当たった敵の位置から破片を放射状に飛ばす。破片はそれ以上増えない
  private shatter(b: Bullet, e: Enemy, s: BulletStats) {
    const base = Math.atan2(b.vy, b.vx) + Math.PI / s.shards;
    for (let i = 0; i < s.shards; i++) {
      const a = base + (i / s.shards) * Math.PI * 2;
      this.addBullet({
        x: e.x + Math.cos(a) * (e.r + 2),
        y: e.y + Math.sin(a) * (e.r + 2),
        vx: Math.cos(a) * s.speed,
        vy: Math.sin(a) * s.speed,
        bouncesLeft: 0,
        pierceLeft: 0,
        splitLeft: 0,
        life: s.shardLife,
        maxLife: s.shardLife,
        dmg: s.damage,
        gen: 2,
        shotId: b.shotId,
        hit: new Set([e]),
        dead: false,
      });
    }
  }

  // ---------------- レベルアップ ----------------

  private checkLevelUp() {
    const need = xpToNext(this.level);
    if (this.xp < need) return;
    this.xp -= need;
    this.level++;
    const candidates = ABILITIES.filter((a) => this.build[a.id] < a.max);
    if (candidates.length === 0) {
      this.player.hp = Math.min(PLAYER.maxHp, this.player.hp + 1);
      return;
    }
    const choices: Choice[] = Phaser.Utils.Array.Shuffle([...candidates])
      .slice(0, 3)
      .map((def) => ({ def, next: this.build[def.id] + 1 }));
    this.state = 'levelup';
    ui.showLevelUp(choices, (id: AbilityId) => {
      this.build[id] = Math.min(ABILITY_BY_ID[id].max, this.build[id] + 1);
      this.onBuildChanged();
      this.state = 'play';
      this.player.cooldown = 0.15; // 選択クリックがそのまま射撃にならないように
    });
  }

  // ---------------- 演出 ----------------

  private burst(x: number, y: number, n: number, color: number, speed: number, life: number, r: number) {
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= LIMITS.particles) this.particles.shift();
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
  }

  private drawArena() {
    const bg = this.add.graphics().setDepth(0);
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
    bg.lineStyle(2, 0x5a6b8f, 1);
    bg.strokeRect(L, T, R - L, B - T);
  }

  private render() {
    const g = this.g;
    const s = this.stats;
    g.clear();

    // 出現予告
    for (const p of this.pending) {
      const k = 1 - p.t / SPAWN.telegraph;
      const r = ENEMY_KINDS[p.kind].r;
      g.lineStyle(2, 0xff4a4a, 0.3 + 0.5 * k);
      g.strokeCircle(p.x, p.y, r * (2 - k));
      g.fillStyle(0xff4a4a, 0.15 * k);
      g.fillCircle(p.x, p.y, r);
    }

    // 敵
    for (const e of this.enemies) {
      const k = ENEMY_KINDS[e.kind];
      g.fillStyle(e.flash > 0 ? 0xffffff : k.color, 1);
      g.fillCircle(e.x, e.y, e.r);
      g.fillStyle(0x000000, 0.35);
      g.fillCircle(e.x, e.y, e.r * 0.45);
      if (e.maxHp > 1.5 && e.hp < e.maxHp) {
        const w = e.r * 2;
        g.fillStyle(0x000000, 0.6);
        g.fillRect(e.x - w / 2, e.y - e.r - 8, w, 4);
        g.fillStyle(0x7dff8a, 1);
        g.fillRect(e.x - w / 2, e.y - e.r - 8, w * Math.max(0, e.hp / e.maxHp), 4);
      }
    }

    // 誘爆
    for (const r of this.rings) {
      const k = r.life / RING_LIFE;
      g.fillStyle(0xff9a3a, 0.18 * k);
      g.fillCircle(r.x, r.y, r.r * (1.1 - 0.3 * k));
      g.lineStyle(3, 0xffc070, k);
      g.strokeCircle(r.x, r.y, r.r * (1.1 - 0.3 * k));
    }

    // 弾（軌跡 + 本体）
    for (const b of this.bullets) {
      const color = GEN_COLORS[Math.min(b.gen, GEN_COLORS.length - 1)];
      // 寿命の最後の25%で小さく薄くなり、射程の終わりが見える
      const fade = Math.min(1, b.life / (b.maxLife * 0.25));
      const r = this.radiusOf(b) * (0.5 + 0.5 * fade);
      g.lineStyle(r * 1.2, color, 0.25 * fade);
      g.lineBetween(b.x - b.vx * 0.03, b.y - b.vy * 0.03, b.x, b.y);
      g.fillStyle(color, 0.3 + 0.7 * fade);
      g.fillCircle(b.x, b.y, r);
    }

    // パーティクル
    for (const p of this.particles) {
      g.fillStyle(p.color, Math.max(0, p.life / p.max));
      g.fillCircle(p.x, p.y, p.r);
    }

    // プレイヤー
    const pl = this.player;
    if (this.state !== 'dead') {
      const blink = pl.inv > 0 && Math.floor(pl.inv * 20) % 2 === 0;
      if (!blink) {
        g.lineStyle(6, 0x9fb4d8, 1);
        g.lineBetween(pl.x, pl.y, pl.x + Math.cos(pl.aim) * (PLAYER.radius + 8), pl.y + Math.sin(pl.aim) * (PLAYER.radius + 8));
        g.fillStyle(0xe8f0ff, 1);
        g.fillCircle(pl.x, pl.y, PLAYER.radius);
        g.fillStyle(0x3a4a66, 1);
        g.fillCircle(pl.x, pl.y, PLAYER.radius * 0.4);
      }
    }

    // 照準
    const ptr = this.input.activePointer;
    g.lineStyle(2, 0xffffff, 0.85);
    g.strokeCircle(ptr.worldX, ptr.worldY, 9);
    g.lineBetween(ptr.worldX - 15, ptr.worldY, ptr.worldX - 5, ptr.worldY);
    g.lineBetween(ptr.worldX + 5, ptr.worldY, ptr.worldX + 15, ptr.worldY);
    g.lineBetween(ptr.worldX, ptr.worldY - 15, ptr.worldX, ptr.worldY - 5);
    g.lineBetween(ptr.worldX, ptr.worldY + 5, ptr.worldX, ptr.worldY + 15);
  }
}
