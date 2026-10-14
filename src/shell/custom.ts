import { SHELLS, type ShellSpec } from './cards';

/**
 * カスタム甲羅：甲羅は常に3つ（甲羅1〜3）。最初はどれも緑甲羅と同じで、
 * ドラフトで取った効果をどれか1つの甲羅に付けて育てる。同じ効果を重ねるとレベルが上がる（上限なし）
 */
export type EffectId = 'homing' | 'split' | 'bounce' | 'pierce' | 'rebound' | 'accel' | 'big' | 'fast' | 'multi';

export interface EffectDef {
  name: string;
  desc: string;
  color: number;
}

// 並び順は、レベルが同じときにどの効果の色で甲羅を塗るかの優先順でもある
export const EFFECTS: Record<EffectId, EffectDef> = {
  homing: { name: '追尾', desc: '投げた瞬間から近くの相手へゆるく曲がる（近づくと曲がるのをやめる）。重ねると曲がる力が強くなる', color: 0xe8453c },
  split: { name: '分裂', desc: '反射したとき左右に子甲羅を飛ばす。重ねると分裂する反射の回数が増える', color: 0xb6d93a },
  multi: { name: '3連', desc: '一度に投げる数が1つ増える（甲羅は少し小さくなる）', color: 0x7fd36b },
  pierce: { name: '貫通', desc: '甲羅や周回甲羅に当たっても割れずに抜ける回数が1増える', color: 0xf2a93b },
  rebound: { name: '反発', desc: '甲羅や周回甲羅に当たっても割れずに跳ね返る回数が1増える（反射として数える）', color: 0xc9d4ea },
  bounce: { name: '跳弾', desc: '反射できる回数が2回、寿命が1.5秒増える', color: 0x2fc7b8 },
  accel: { name: '加速', desc: '反射するたびに速くなる（最大で元の2倍）。重ねると上がり方が大きくなる', color: 0xff7ad9 },
  big: { name: '巨大化', desc: '甲羅が大きくなる。2つ以上重ねると、甲羅同士で相手だけ割る', color: 0x4f6b3a },
  fast: { name: '高速化', desc: '甲羅が25%速くなる', color: 0x9be7ff },
};

export const EFFECT_IDS = Object.keys(EFFECTS) as EffectId[];
export const SHELL_COUNT = 3;

export type ShellLevels = Record<EffectId, number>;

export const emptyLevels = (): ShellLevels => ({ homing: 0, split: 0, bounce: 0, pierce: 0, rebound: 0, accel: 0, big: 0, fast: 0, multi: 0 });
export const emptyLoadout = (): ShellLevels[] => Array.from({ length: SHELL_COUNT }, emptyLevels);

/** 試合開始時の甲羅：甲羅2だけ追尾1、甲羅1・3は緑甲羅相当 */
export const starterLoadout = (): ShellLevels[] => {
  const l = emptyLoadout();
  l[1].homing = 1;
  return l;
};

/** 付いている効果を「追尾2・分裂1」の形で。何もなければ「強化なし」 */
export function summary(lv: ShellLevels): string {
  const parts = EFFECT_IDS.filter((e) => lv[e] > 0).map((e) => `${EFFECTS[e].name}${lv[e]}`);
  return parts.length ? parts.join('・') : '強化なし';
}

/** レベルから甲羅の性能を作る。土台は緑甲羅 */
export function buildSpec(lv: ShellLevels, index: number): ShellSpec {
  const base = SHELLS.normal;
  const top = EFFECT_IDS.reduce<EffectId | null>((best, e) => (lv[e] > 0 && (best === null || lv[e] > lv[best]) ? e : best), null);
  return {
    name: `甲羅${index + 1}`,
    desc: summary(lv),
    color: top ? EFFECTS[top].color : base.color,
    radius: base.radius * (1 + 0.35 * lv.big) * (lv.multi > 0 ? 0.8 : 1),
    speed: base.speed * (1 + 0.25 * lv.fast),
    bounces: base.bounces + 2 * lv.bounce,
    life: base.life + 1.5 * lv.bounce,
    splits: lv.split,
    // 曲がる力はレベルと同じ値（rad/秒）。Lv1 で 1、上限なし
    homingTurn: lv.homing > 0 ? lv.homing : undefined,
    heavy: lv.big >= 2,
    ways: 1 + lv.multi,
    spread: 0.28,
    pierce: lv.pierce,
    rebound: lv.rebound,
    accel: lv.accel > 0 ? 1 + 0.15 * lv.accel : undefined,
  };
}

const shuffled = <T>(xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * 投げる順番：最初は 1→2→3、3つ投げ終えるたびにシャッフルした順番を足す。
 * 順番の来た甲羅が補充中なら、手元にある甲羅のうち順番が一番早いものを先に投げる
 */
export class Rotation {
  private queue: number[] = [0, 1, 2];

  constructor() {
    this.topUp();
  }

  /** 甲羅の番号を、次に投げる順に重複なしで並べたもの */
  order(): number[] {
    const seen: number[] = [];
    for (const i of this.queue) if (!seen.includes(i)) seen.push(i);
    return seen;
  }

  /** 甲羅 slot を投げた：順番待ちの中で最初に出てくる slot を取り除く */
  take(slot: number) {
    this.queue.splice(this.queue.indexOf(slot), 1);
    this.topUp();
  }

  private topUp() {
    while (this.queue.length <= SHELL_COUNT) this.queue.push(...shuffled([0, 1, 2]));
  }
}

export function effectCandidates(n: number): EffectId[] {
  return shuffled(EFFECT_IDS).slice(0, n);
}
