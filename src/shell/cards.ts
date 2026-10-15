import type { ShellLevels } from './custom';

export type ShellType = 'normal' | 'bouncy' | 'split' | 'homing' | 'heavy' | 'triple' | 'fast' | 'pierce' | 'accel';

export interface ShellSpec {
  name: string;
  desc: string;
  color: number;
  radius: number;
  speed: number;
  bounces: number; // この回数を超えて反射すると割れる
  life: number; // 秒
  /** 最初の反射で2つに分かれる */
  split?: boolean;
  /** 分裂する反射の回数（最初の n 回の反射で分裂する）。split: true は 1 と同じ */
  splits?: number;
  /** 1回反射した後、投げた人以外の一番近いキャラへ曲がる（rad/s） */
  homingTurn?: number;
  /** 甲羅同士でぶつかったとき、相手だけ割る */
  heavy?: boolean;
  /** 一度に投げる数と、その間の角度（rad） */
  ways?: number;
  spread?: number;
  /** 甲羅や周回甲羅に当たっても割れずに通り抜けられる回数 */
  pierce?: number;
  /** 甲羅や周回甲羅に当たっても割れずに跳ね返る回数（壁での反射と同じに数える） */
  rebound?: number;
  /** 反射するたびに速さにかける倍率（元の速さの2倍まで） */
  accel?: number;
  /** 一定の向き（時計回り）に曲がり続ける速さ（rad/s） */
  curve?: number;
  /** カスタム甲羅：この性能の元になった効果のレベル（見た目のトッピングに使う） */
  levels?: ShellLevels;
}

/** 甲羅の速さ全体にかける倍率 */
export const SPEED_SCALE = 0.8;

export const SHELLS: Record<ShellType, ShellSpec> = {
  normal: { name: 'ノーマル甲羅', desc: '標準。4回反射', color: 0x3fae3f, radius: 9, speed: 400 * SPEED_SCALE, bounces: 4, life: 6 },
  bouncy: { name: '跳ね甲羅', desc: '遅いが9回反射し、長く残る', color: 0x2fc7b8, radius: 8, speed: 300 * SPEED_SCALE, bounces: 9, life: 9 },
  split: { name: '分裂甲羅', desc: '最初の反射で、左右に子甲羅を2つ飛ばす', color: 0xb6d93a, radius: 9, speed: 380 * SPEED_SCALE, bounces: 3, life: 6, split: true },
  homing: { name: '追尾甲羅', desc: '投げた瞬間から近くの相手を追う（近づくと曲がるのをやめる）', color: 0xe8453c, radius: 9, speed: 340 * SPEED_SCALE, bounces: 3, life: 6, homingTurn: 3 },
  heavy: { name: '重甲羅', desc: '大きく遅い。甲羅同士なら相手だけ割る', color: 0x4f6b3a, radius: 15, speed: 260 * SPEED_SCALE, bounces: 2, life: 6, heavy: true },
  // ここから下はローグライクの能力（弾数増加・高速化・貫通・反射チャージ）を甲羅にしたもの
  triple: { name: '3連甲羅', desc: '小さな甲羅を3方向に同時に投げる。反射2回', color: 0x7fd36b, radius: 7, speed: 320 * SPEED_SCALE, bounces: 2, life: 5, ways: 3, spread: 0.28 },
  fast: { name: '高速甲羅', desc: '1.5倍速いが、反射2回で割れる', color: 0x9be7ff, radius: 8, speed: 600 * SPEED_SCALE, bounces: 2, life: 4 },
  pierce: { name: '貫通甲羅', desc: '甲羅や周回甲羅に1回当たっても割れずに抜ける', color: 0xf2a93b, radius: 9, speed: 360 * SPEED_SCALE, bounces: 3, life: 6, pierce: 1 },
  accel: { name: '加速甲羅', desc: '遅く出て、反射するたびに速くなる（最大2倍）', color: 0xff7ad9, radius: 9, speed: 260 * SPEED_SCALE, bounces: 4, life: 7, accel: 1.2 },
};

/** 分裂でできた子甲羅 */
export const SPLIT_CHILD: ShellSpec = { name: '', desc: '', color: 0xeaff8a, radius: 7, speed: 380 * SPEED_SCALE, bounces: 1, life: 3 };
/** 子甲羅が親の反射方向から左右に開く角度（rad） */
export const SPLIT_ANGLE = 0.5;

export const DECK: ShellType[] = ['normal', 'normal', 'bouncy', 'bouncy', 'split', 'split', 'homing', 'heavy'];

/**
 * ドラフト：ラウンドごとにプレイヤー数ぶんの候補を並べ、脱落した順（勝者が最後）に
 * 「候補1枚とデッキの1枚を交換」か「交換しない」を選ぶ。デッキの枚数は変わらない。先に winTarget 勝した人が優勝
 */
export const MATCH = { winTarget: 5 };
export const STARTER_DECK: ShellType[] = ['normal', 'normal', 'normal', 'normal', 'normal', 'normal'];
export const DRAFT_POOL: ShellType[] = ['bouncy', 'split', 'homing', 'heavy', 'triple', 'fast', 'pierce', 'accel'];

export function draftCandidates(n: number): ShellType[] {
  return shuffled(DRAFT_POOL).slice(0, n);
}
/**
 * pick: false … テトリス方式。今の甲羅しか投げられず、次に来る甲羅が previewCount 個見える。
 *               山札は8枚1組をシャッフルして順に出し、尽きたら次の組をシャッフルする
 * pick: true  … 手札方式。手札3枚から選んで投げ、使ったカードは山札の一番下へ戻る（0.6秒で補充）
 */
export const CARD_RULE = { pick: false, previewCount: 3 };

const shuffled = <T>(xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export class Hand {
  readonly size = CARD_RULE.pick ? 3 : 1;
  private readonly drawDelay = CARD_RULE.pick ? 0.6 : 0;
  slots: (ShellType | null)[] = [];
  refill: number[] = [];
  queue: ShellType[] = [];
  selected = 0;

  constructor(private readonly deck: ShellType[] = DECK) {
    this.queue = shuffled(deck);
    for (let i = 0; i < this.size; i++) {
      this.slots.push(this.queue.shift()!);
      this.refill.push(0);
    }
    this.topUp();
  }

  /** これから来る甲羅（先頭が次） */
  upcoming(n: number) {
    return this.queue.slice(0, n);
  }

  update(dt: number) {
    for (let i = 0; i < this.size; i++) {
      if (this.slots[i] !== null) continue;
      this.refill[i] -= dt;
      if (this.refill[i] <= 0) this.slots[i] = this.queue.shift()!;
    }
    this.topUp();
  }

  /** i 番目のカードを使う。使えなければ null */
  use(i: number): ShellType | null {
    const t = this.slots[i];
    if (!t) return null;
    this.slots[i] = null;
    this.refill[i] = this.drawDelay;
    if (CARD_RULE.pick) this.queue.push(t);
    else if (this.drawDelay === 0) this.update(0);
    return t;
  }

  private topUp() {
    if (CARD_RULE.pick) return;
    while (this.queue.length <= CARD_RULE.previewCount) this.queue.push(...shuffled(this.deck));
  }
}
