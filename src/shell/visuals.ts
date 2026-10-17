import type * as Phaser from 'phaser';
import { SHELLS, type ShellSpec } from './cards';
import { EFFECTS, EFFECT_IDS } from './custom';

/**
 * 甲羅の塗り分け（円グラフ）：付いている効果を、レベルの割合で扇形にする。レベルの高い順に12時から時計回り。
 * 効果のない甲羅や、カード甲羅などレベルを持たない甲羅は null（甲羅の色1色で塗る）
 */
export function pieOf(spec: ShellSpec): { color: number; frac: number }[] | null {
  const lv = spec.levels;
  if (!lv) return null;
  const list = EFFECT_IDS.filter((e) => lv[e] > 0).sort((a, b) => lv[b] - lv[a]);
  const total = list.reduce((n, e) => n + lv[e], 0);
  if (total === 0) return null;
  return list.map((e) => ({ color: EFFECTS[e].color, frac: lv[e] / total }));
}

/** 円グラフの塗り（SVG）。parts が1つなら円 */
function pieSvgFill(x: number, y: number, r: number, parts: { color: number; frac: number }[]): string {
  if (parts.length === 1) return `<circle cx="${x}" cy="${y}" r="${r}" fill="${hex(parts[0].color)}"/>`;
  let a = -Math.PI / 2;
  return parts
    .map((p) => {
      const b = a + p.frac * Math.PI * 2;
      const large = b - a > Math.PI ? 1 : 0;
      const d = `M${x} ${y}L${x + Math.cos(a) * r} ${y + Math.sin(a) * r}A${r} ${r} 0 ${large} 1 ${x + Math.cos(b) * r} ${y + Math.sin(b) * r}Z`;
      a = b;
      return `<path d="${d}" fill="${hex(p.color)}"/>`;
    })
    .join('');
}

/**
 * 甲羅の見た目。効果ごとに模様を決め、ゲーム画面（Graphics）と HUD（SVG）で同じルールで描く。
 * 相手の周りを回る甲羅を見れば、どんな効果が付いているか分かるようにする。
 */
export interface Marks {
  homing: boolean; // 目玉
  split: boolean; // V字
  pierce: boolean; // トゲ
  rebound: boolean; // 外側の輪
  big: boolean; // 太い縁
  accel: boolean; // 後ろに山形
  fast: boolean; // 後ろに流線
  bounce: boolean; // 内側の点の輪
  multi: boolean; // 3つの小円（周回・アイコンのみ）
  curve: boolean; // 横に弧の矢印
  slow: boolean; // 前に逆向きの山形
}

/** 性能から模様を決める（カード甲羅の種類にもカスタム甲羅にも使える） */
export function marksOf(spec: ShellSpec): Marks {
  const base = SHELLS.normal;
  return {
    homing: !!spec.homingTurn,
    split: (spec.splits ?? (spec.split ? 1 : 0)) > 0,
    pierce: (spec.pierce ?? 0) > 0,
    rebound: (spec.rebound ?? 0) > 0,
    big: !!spec.heavy || spec.radius > base.radius * 1.2,
    accel: !!spec.accel,
    fast: spec.speed > base.speed * 1.1,
    bounce: spec.bounces > base.bounces,
    multi: (spec.ways ?? 1) > 1,
    curve: !!spec.curve,
    slow: spec.speed < base.speed * 0.9,
  };
}

export const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export function shade(c: number, k: number) {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
  const b = Math.min(255, Math.round((c & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/**
 * 甲羅を1つ描く。angle は進行方向（目玉や流線の向き）。
 * live は飛んでいる甲羅の残り状態（分裂済み・貫通を使い切った…など）で、模様を消すのに使う
 */
export function drawShell(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  r: number,
  spec: ShellSpec,
  angle: number,
  alpha: number,
  live?: Partial<Marks>,
) {
  const m = { ...marksOf(spec), ...live };
  const fx = Math.cos(angle);
  const fy = Math.sin(angle);

  // 後ろの模様（流線・山形）
  if (m.fast) {
    g.lineStyle(1.5, 0xffffff, 0.55 * alpha);
    for (const side of [-0.45, 0.45]) {
      const px = -fy * side * r;
      const py = fx * side * r;
      g.lineBetween(x - fx * r * 1.2 + px, y - fy * r * 1.2 + py, x - fx * r * 2.2 + px, y - fy * r * 2.2 + py);
    }
  }
  if (m.accel) {
    g.lineStyle(1.5, 0xff9de6, 0.8 * alpha);
    for (const back of [1.35, 1.85]) {
      const cx = x - fx * r * back;
      const cy = y - fy * r * back;
      g.lineBetween(cx - fx * 3 - fy * 4, cy - fy * 3 + fx * 4, cx, cy);
      g.lineBetween(cx - fx * 3 + fy * 4, cy - fy * 3 - fx * 4, cx, cy);
    }
  }

  // 本体：外側の色、内側に一段暗い甲羅の模様、ハイライト
  // SFC 風：黒い輪郭、平たい塗り、甲羅の六角の模様、四角いハイライト
  g.fillStyle(0x000000, alpha);
  g.fillCircle(x, y, r + (m.big ? 3 : 2));
  g.fillStyle(shade(spec.color, 0.65), alpha);
  g.fillCircle(x, y, r);
  g.fillStyle(spec.color, alpha);
  g.fillCircle(x - 1, y - 1, r - 1.5);
  g.lineStyle(1.5, shade(spec.color, 0.5), alpha);
  g.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = x + Math.cos(a) * r * 0.45;
    const py = y + Math.sin(a) * r * 0.45;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.strokePath();
  g.fillStyle(0xffffff, 0.8 * alpha);
  g.fillRect(Math.round(x - r * 0.55), Math.round(y - r * 0.6), 3, 3);

  if (m.bounce) {
    g.fillStyle(0xffffff, 0.8 * alpha);
    for (let i = 0; i < 4; i++) {
      const a = angle + Math.PI / 4 + (i * Math.PI) / 2;
      g.fillCircle(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8, 1.2);
    }
  }
  if (m.pierce) {
    g.lineStyle(2, 0xffd08a, alpha);
    for (let i = 0; i < 4; i++) {
      const a = angle + (i * Math.PI) / 2;
      g.lineBetween(x + Math.cos(a) * r, y + Math.sin(a) * r, x + Math.cos(a) * (r + 4), y + Math.sin(a) * (r + 4));
    }
  }
  if (m.rebound) {
    g.lineStyle(1.5, 0xffffff, 0.75 * alpha);
    g.strokeCircle(x, y, r + 4);
  }
  if (m.split) {
    g.lineStyle(2, 0xffffff, 0.9 * alpha);
    for (const side of [-1, 1]) {
      g.lineBetween(x - fx * r * 0.5, y - fy * r * 0.5, x + Math.cos(angle + side * 0.8) * r * 0.75, y + Math.sin(angle + side * 0.8) * r * 0.75);
    }
  }
  if (m.homing) {
    const ex = x + fx * r * 0.32;
    const ey = y + fy * r * 0.32;
    g.fillStyle(0xffffff, alpha);
    g.fillCircle(ex, ey, Math.max(2, r * 0.32));
    g.fillStyle(0x111111, alpha);
    g.fillCircle(ex + fx * r * 0.1, ey + fy * r * 0.1, Math.max(1, r * 0.15));
  }
}

/** HUD 用の甲羅アイコン（SVG 文字列）。模様は drawShell と同じルール */
export function shellSvg(spec: ShellSpec, size = 26): string {
  const m = marksOf(spec);
  const c = size / 2;
  const r = size * (m.multi ? 0.2 : 0.3);
  const pie = pieOf(spec);
  // 効果が付いていれば円グラフで塗る。なければ甲羅の色に、内側を一段暗くした模様
  const body = (x: number, y: number, rr: number) =>
    (pie
      ? pieSvgFill(x, y, rr, pie) + `<circle cx="${x}" cy="${y}" r="${rr}" fill="none" stroke="#eaffea" stroke-width="${m.big ? 2.4 : 1.2}"/>`
      : `<circle cx="${x}" cy="${y}" r="${rr}" fill="${hex(spec.color)}" stroke="#eaffea" stroke-width="${m.big ? 2.4 : 1.2}"/>` +
        `<circle cx="${x}" cy="${y}" r="${rr * 0.62}" fill="${hex(shade(spec.color, 0.62))}"/>`) +
    `<circle cx="${x - rr * 0.35}" cy="${y - rr * 0.35}" r="${rr * 0.25}" fill="#fff" fill-opacity=".35"/>`;
  let s = '';
  if (m.fast) s += `<path d="M${c - r * 2.1} ${c - r * 0.45}h${r * 0.9}M${c - r * 2.1} ${c + r * 0.45}h${r * 0.9}" stroke="#fff" stroke-opacity=".6" stroke-width="1.3"/>`;
  if (m.accel) s += `<path d="M${c - r * 1.9} ${c - 3}l3 3-3 3M${c - r * 1.5} ${c - 3}l3 3-3 3" fill="none" stroke="#ff9de6" stroke-width="1.3"/>`;
  if (m.multi) {
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      s += body(c + Math.cos(a) * r * 1.2, c + Math.sin(a) * r * 1.2, r);
    }
  } else {
    s += body(c, c, r);
  }
  const R = m.multi ? r * 2.3 : r;
  if (m.bounce) for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    s += `<circle cx="${c + Math.cos(a) * R * 0.8}" cy="${c + Math.sin(a) * R * 0.8}" r="1" fill="#fff"/>`;
  }
  if (m.pierce) for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    s += `<line x1="${c + Math.cos(a) * R}" y1="${c + Math.sin(a) * R}" x2="${c + Math.cos(a) * (R + 3)}" y2="${c + Math.sin(a) * (R + 3)}" stroke="#ffd08a" stroke-width="1.6"/>`;
  }
  if (m.rebound) s += `<circle cx="${c}" cy="${c}" r="${R + 3}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.1"/>`;
  if (m.split) s += `<path d="M${c - r * 0.5} ${c}L${c + r * 0.55} ${c - r * 0.55}M${c - r * 0.5} ${c}L${c + r * 0.55} ${c + r * 0.55}" stroke="#fff" stroke-width="1.5"/>`;
  if (m.curve) s += `<path d="M${c - R * 0.9} ${c - R - 2.5}A${R + 2.5} ${R + 2.5} 0 0 1 ${c + R + 2.5} ${c + R * 0.2}" fill="none" stroke="#9cc0ff" stroke-width="1.4"/><path d="M${c + R + 0.5} ${c + R * 0.2 - 2}l2 3.2 2-3.2" fill="none" stroke="#9cc0ff" stroke-width="1.4"/>`;
  if (m.slow) s += `<path d="M${c + R + 4.5} ${c - 3}l-3 3 3 3M${c + R + 8} ${c - 3}l-3 3 3 3" fill="none" stroke="#c8b8ff" stroke-width="1.3"/>`;
  if (m.homing) s += `<circle cx="${c + r * 0.32}" cy="${c}" r="${Math.max(1.6, r * 0.32)}" fill="#fff"/><circle cx="${c + r * 0.42}" cy="${c}" r="${Math.max(0.8, r * 0.15)}" fill="#111"/>`;
  return `<svg class="shell-ico" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${s}</svg>`;
}
