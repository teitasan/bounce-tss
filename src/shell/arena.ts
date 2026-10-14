import { ARENA } from '../config';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const L = ARENA.wall;
export const R = ARENA.width - ARENA.wall;
export const T = ARENA.wall;
export const B = ARENA.height - ARENA.wall;

/** 甲羅バトル用の障害物（点対称に配置） */
export const PILLARS: Rect[] = [
  { x: 600, y: 320, w: 80, h: 80 },
  { x: 280, y: 150, w: 40, h: 170 },
  { x: 960, y: 400, w: 40, h: 170 },
  { x: 800, y: 150, w: 170, h: 40 },
  { x: 310, y: 530, w: 170, h: 40 },
];

export const SPAWNS = [
  { x: 110, y: 110 },
  { x: ARENA.width - 110, y: ARENA.height - 110 },
  { x: ARENA.width - 110, y: 110 },
  { x: 110, y: ARENA.height - 110 },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 円を外壁と障害物の外へ押し出す */
export function resolveCircle(p: { x: number; y: number }, r: number) {
  p.x = clamp(p.x, L + r, R - r);
  p.y = clamp(p.y, T + r, B - r);
  for (const rc of PILLARS) {
    const cx = clamp(p.x, rc.x, rc.x + rc.w);
    const cy = clamp(p.y, rc.y, rc.y + rc.h);
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) continue;
    if (d2 > 0) {
      const d = Math.sqrt(d2);
      p.x = cx + (dx / d) * r;
      p.y = cy + (dy / d) * r;
    } else {
      // 中心が矩形の中：近い辺へ出す
      const left = p.x - rc.x;
      const right = rc.x + rc.w - p.x;
      const top = p.y - rc.y;
      const bottom = rc.y + rc.h - p.y;
      const m = Math.min(left, right, top, bottom);
      if (m === left) p.x = rc.x - r;
      else if (m === right) p.x = rc.x + rc.w + r;
      else if (m === top) p.y = rc.y - r;
      else p.y = rc.y + rc.h + r;
    }
  }
}

export interface Mover {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const STEP = 5;

/**
 * 甲羅を dist だけ進め、外壁と障害物で反射させる。
 * onStep は細かく刻んだ各位置で呼ばれ、true を返すとそこで止める。戻り値は反射回数。
 */
export function moveShell(s: Mover, r: number, dist: number, onStep?: () => boolean): number {
  let bounces = 0;
  const steps = Math.max(1, Math.ceil(dist / STEP));
  const sp = Math.hypot(s.vx, s.vy) || 1;
  const d = dist / steps;
  for (let i = 0; i < steps; i++) {
    s.x += (s.vx / sp) * d;
    s.y += (s.vy / sp) * d;
    if (s.x - r < L) {
      s.x = L + r;
      s.vx = Math.abs(s.vx);
      bounces++;
    } else if (s.x + r > R) {
      s.x = R - r;
      s.vx = -Math.abs(s.vx);
      bounces++;
    }
    if (s.y - r < T) {
      s.y = T + r;
      s.vy = Math.abs(s.vy);
      bounces++;
    } else if (s.y + r > B) {
      s.y = B - r;
      s.vy = -Math.abs(s.vy);
      bounces++;
    }
    for (const rc of PILLARS) {
      const cx = clamp(s.x, rc.x, rc.x + rc.w);
      const cy = clamp(s.y, rc.y, rc.y + rc.h);
      const dx = s.x - cx;
      const dy = s.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      let nx: number;
      let ny: number;
      if (d2 > 0) {
        const dd = Math.sqrt(d2);
        nx = dx / dd;
        ny = dy / dd;
        s.x = cx + nx * r;
        s.y = cy + ny * r;
      } else {
        nx = -s.vx / sp;
        ny = -s.vy / sp;
      }
      const dot = s.vx * nx + s.vy * ny;
      if (dot < 0) {
        s.vx -= 2 * dot * nx;
        s.vy -= 2 * dot * ny;
        bounces++;
      }
    }
    if (onStep?.()) break;
  }
  return bounces;
}
