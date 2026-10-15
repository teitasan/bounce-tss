import { SHELLS, type ShellSpec } from './cards';
import type { EffectId, ShellLevels } from './custom';

/**
 * ピザのお試し描画（SVG）。効果をトッピングで表し、同じ効果を重ねるとトッピングが増える。
 *   追尾=ブラックオリーブ / 分裂=切れ目 / 拡散=ミニピザ3枚 / 貫通=ハラペーニョ / 反発=ふっくらした耳
 *   跳弾=ペパロニ / 加速=赤唐辛子 / 巨大化=分厚い生地 / 高速化=バジル
 */
export const TOPPINGS: Record<EffectId, { name: string; color: string }> = {
  homing: { name: 'ブラックオリーブ', color: '#2b2622' },
  split: { name: '切れ目', color: '#fff4d6' },
  multi: { name: 'ミニピザ3枚', color: '#f3cf6b' },
  pierce: { name: 'ハラペーニョ', color: '#5aa83a' },
  rebound: { name: 'ふっくら耳', color: '#e8a95a' },
  bounce: { name: 'ペパロニ', color: '#b8322a' },
  accel: { name: '赤唐辛子', color: '#e2382c' },
  slow: { name: 'マッシュルーム', color: '#d8c8b0' },
  curve: { name: 'オニオン', color: '#e8d8f0' },
  big: { name: '分厚い生地', color: '#c98a45' },
  fast: { name: 'バジル', color: '#3f8f3a' },
};

// トッピングを置く場所（中心からの距離と角度）。内側の円 → 外側の円の順に埋める
const SLOTS: [number, number][] = [
  ...Array.from({ length: 4 }, (_, i) => [11, i * 90 + 45] as [number, number]),
  ...Array.from({ length: 9 }, (_, i) => [25, i * 40 + 10] as [number, number]),
  [0, 0],
  ...Array.from({ length: 9 }, (_, i) => [25, i * 40 + 30] as [number, number]),
];

const piece = (kind: EffectId, x: number, y: number, rot: number): string => {
  const t = `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot})`;
  switch (kind) {
    case 'bounce': // ペパロニ：赤い円に脂の点
      return `<g transform="${t}"><circle r="7.5" fill="#b8322a" stroke="#8e2219" stroke-width="1"/><circle cx="-2.5" cy="-2" r="1.1" fill="#e2695c"/><circle cx="2.4" cy="1.6" r="1" fill="#e2695c"/><circle cx="0.5" cy="-3.6" r=".8" fill="#e2695c"/></g>`;
    case 'homing': // オリーブ：黒い輪（目玉に見える）
      return `<g transform="${t}"><circle r="4.6" fill="#2b2622"/><circle r="1.8" fill="#f3cf6b"/></g>`;
    case 'pierce': // ハラペーニョ：緑の輪切りと種
      return `<g transform="${t}"><circle r="5.6" fill="#5aa83a" stroke="#3d7a25" stroke-width="1"/><circle r="3.4" fill="#c9e7a6"/><circle cx="-1" cy="-.8" r=".7" fill="#f4f0d8"/><circle cx="1.2" cy=".6" r=".7" fill="#f4f0d8"/><circle cx="-.2" cy="1.5" r=".7" fill="#f4f0d8"/></g>`;
    case 'accel': // 赤唐辛子：細長い実とヘタ
      return `<g transform="${t}"><path d="M-7 1 Q-1 -6 7 -2 Q1 3 -7 1Z" fill="#e2382c" stroke="#a5221a" stroke-width=".8"/><path d="M7 -2 l3 -2.5" stroke="#3f8f3a" stroke-width="1.8" stroke-linecap="round"/></g>`;
    case 'fast': // バジル：葉と葉脈
      return `<g transform="${t}"><ellipse rx="7" ry="3.6" fill="#3f8f3a"/><path d="M-6 0 H6" stroke="#2c6a28" stroke-width=".8"/></g>`;
    default:
      return '';
  }
};

/**
 * 1枚のピザ（viewBox 100 の中、中心 cx,cy、半径 R）。
 * simple: 小さく描くとき用。トッピングは種類ごとに1つだけ、大きく載せる（数ではなく種類で見分ける）
 */
function pizzaBody(lv: Partial<ShellLevels>, cx: number, cy: number, R: number, simple = false): string {
  const L = (e: EffectId) => lv[e] ?? 0;
  const k = R / 48;
  const thick = L('big') > 0;
  const inner = (thick ? 38 : 42) * k;
  let s = `<g>`;
  // 耳（反発はふっくらした凸凹の耳）
  if (L('rebound') > 0) {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      s += `<circle cx="${(cx + Math.cos(a) * (R - 3 * k)).toFixed(1)}" cy="${(cy + Math.sin(a) * (R - 3 * k)).toFixed(1)}" r="${(7 + 1.5 * Math.min(3, L('rebound'))) * k}" fill="#e8a95a" stroke="#b97a35" stroke-width="${1.2 * k}"/>`;
    }
  }
  s += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${thick ? '#c98a45' : '#d99a4e'}" stroke="#a96c2e" stroke-width="${(thick ? 3 : 2) * k}"/>`;
  // ソースとチーズ
  s += `<circle cx="${cx}" cy="${cy}" r="${inner}" fill="#c4422c"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${inner - 3 * k}" fill="#f3cf6b"/>`;
  for (const [dx, dy, r] of [[-12, -8, 7], [10, 12, 6], [14, -14, 5], [-16, 14, 5]]) s += `<circle cx="${cx + dx * k}" cy="${cy + dy * k}" r="${r * k}" fill="#f8e3a0" opacity=".8"/>`;
  // トッピング：効果ごとに 2 × レベル 個
  const list: EffectId[] = [];
  for (const e of ['bounce', 'pierce', 'homing', 'accel', 'fast'] as EffectId[]) for (let i = 0; i < (simple ? Math.min(1, L(e)) : 2 * L(e)); i++) list.push(e);
  // 簡略版：1種類なら真ん中に大きく、2〜4種類なら十字に並べる
  const simpleSlots: [number, number][][] = [[], [[0, 0]], [[14, 180], [14, 0]], [[15, 210], [15, 330], [15, 90]], [[15, 225], [15, 315], [15, 45], [15, 135]], [[0, 0], [17, 225], [17, 315], [17, 45], [17, 135]]];
  const slots = simple ? simpleSlots[Math.min(list.length, 5)] : SLOTS;
  list.slice(0, slots.length).forEach((e, i) => {
    const [d, deg] = slots[i];
    const a = (deg * Math.PI) / 180;
    const scale = (inner / (42 * k)) * k * (simple ? (list.length === 1 ? 2.6 : 1.8) : 1);
    const pos = (inner / (42 * k)) * k;
    s += `<g transform="translate(${cx + Math.cos(a) * d * pos} ${cy + Math.sin(a) * d * pos}) scale(${scale})">${piece(e, 0, 0, simple ? 0 : deg * 2)}</g>`;
  });
  // 分裂：切れ目（レベルが上がるほど細かく切れる）
  const cuts = L('split') > 0 ? (simple ? 2 : 1 + L('split')) : 0;
  for (let i = 0; i < cuts; i++) {
    const a = (i / cuts) * Math.PI;
    const dx = Math.cos(a) * inner;
    const dy = Math.sin(a) * inner;
    s += `<line x1="${cx - dx}" y1="${cy - dy}" x2="${cx + dx}" y2="${cy + dy}" stroke="#fff4d6" stroke-width="${(simple ? 4 : 2.2) * k}" stroke-linecap="round" opacity=".9"/>`;
  }
  return s + '</g>';
}

/** 効果のレベルからピザを描く。拡散はミニピザ3枚。48px 未満は自動で簡略版にする */
export function pizzaSvg(lv: Partial<ShellLevels>, size = 64, simple = size < 48): string {
  let body = '';
  if ((lv.multi ?? 0) > 0) {
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      body += pizzaBody({ ...lv, multi: 0 }, 50 + Math.cos(a) * 25, 50 + Math.sin(a) * 25, 24, simple);
    }
  } else {
    body = pizzaBody(lv, 50, 50, 48, simple);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-6 -6 112 112" aria-hidden="true">${body}</svg>`;
}

/** 甲羅の性能からトッピングを決める。カスタム甲羅はレベルそのまま、それ以外は性能から推定（各1） */
export function levelsOf(spec: ShellSpec): Partial<ShellLevels> {
  if (spec.levels) return spec.levels;
  const base = SHELLS.normal;
  return {
    homing: spec.homingTurn ? 1 : 0,
    split: (spec.splits ?? (spec.split ? 1 : 0)) > 0 ? 1 : 0,
    pierce: spec.pierce ? 1 : 0,
    rebound: spec.rebound ? 1 : 0,
    bounce: spec.bounces > base.bounces ? 1 : 0,
    accel: spec.accel ? 1 : 0,
    slow: spec.speed < base.speed * 0.9 ? 1 : 0,
    curve: spec.curve ? 1 : 0,
    fast: spec.speed > base.speed * 1.1 ? 1 : 0,
    big: spec.heavy || spec.radius > base.radius * 1.2 ? 1 : 0,
    multi: (spec.ways ?? 1) > 1 ? 1 : 0,
  };
}

/** ゲーム画面で貼る画像の元になる SVG（簡略版。拡散は cluster のときだけミニピザ3枚） */
export function pizzaTextureSvg(spec: ShellSpec, cluster: boolean, px = 96): { key: string; svg: string } {
  const lv = { ...levelsOf(spec) };
  if (!cluster) lv.multi = 0;
  const ids: EffectId[] = ['homing', 'split', 'multi', 'pierce', 'rebound', 'bounce', 'accel', 'slow', 'curve', 'big', 'fast'];
  const key = `pizza:${ids.map((e) => lv[e] ?? 0).join('.')}`;
  return { key, svg: pizzaSvg(lv, px, true) };
}
