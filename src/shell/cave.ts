import { B, L, R, SPAWNS, T } from './arena';

/**
 * セル・オートマトンで作る洞窟のような試合場。
 * 試合場の内側を CELL 四方のマス目に分け、ランダムに壁を置いてから「周りに壁が多いマスは壁、少ないマスは床」を
 * 数回くり返して、なめらかな塊にする。種（seed）が同じなら同じ地形になる（オンライン対戦は種だけ送る）
 */
export const CAVE = {
  cell: 40,
  fill: 0.43, // 最初に壁にする割合
  steps: 4, // くり返す回数
  birth: 5, // 床のマスは、周り8マスの壁がこの数以上なら壁になる
  survive: 4, // 壁のマスは、周り8マスの壁がこの数以上なら壁のまま
  spawnClear: 2, // 出現位置からこのマス数以内は床にする
  openMin: 0.6, // 床の割合がこの範囲に入るまで作り直す
  openMax: 0.8,
};

export const COLS = Math.floor((R - L) / CAVE.cell);
export const ROWS = Math.floor((B - T) / CAVE.cell);

export interface CaveMap {
  seed: number;
  /** COLS × ROWS。1 が壁 */
  solid: Uint8Array;
}

/** 種から決まる乱数（mulberry32） */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const idx = (c: number, r: number) => r * COLS + c;

/** 種から洞窟を作る。床がつながっていない・広さが範囲外なら、同じ乱数を進めて作り直す */
export function generateCave(seed: number): CaveMap {
  const rand = rng(seed);
  for (let attempt = 0; attempt < 50; attempt++) {
    const solid = tryGenerate(rand);
    if (solid) return { seed, solid };
  }
  return { seed, solid: new Uint8Array(COLS * ROWS) };
}

function tryGenerate(rand: () => number): Uint8Array | null {
  let g = new Uint8Array(COLS * ROWS);
  // 最初のノイズを点対称にしておけば、ルールも対称なので出来上がりも点対称になる（どの出現位置も同じ条件）
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const m = idx(COLS - 1 - c, ROWS - 1 - r);
      g[idx(c, r)] = m < idx(c, r) ? g[m] : rand() < CAVE.fill ? 1 : 0;
    }
  for (let s = 0; s < CAVE.steps; s++) {
    const next = new Uint8Array(COLS * ROWS);
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        let n = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const cc = c + dc;
            const rr = r + dr;
            // 外壁の外は床として数える（外壁沿いが壁で埋まりすぎないように）
            if (cc >= 0 && cc < COLS && rr >= 0 && rr < ROWS) n += g[idx(cc, rr)];
          }
        next[idx(c, r)] = g[idx(c, r)] ? (n >= CAVE.survive ? 1 : 0) : n >= CAVE.birth ? 1 : 0;
      }
    g = next;
  }
  // 出現位置のまわりは床にする
  const spawnCells = SPAWNS.map((p) => [Math.floor((p.x - L) / CAVE.cell), Math.floor((p.y - T) / CAVE.cell)]);
  for (const [sc, sr] of spawnCells)
    for (let r = sr - CAVE.spawnClear; r <= sr + CAVE.spawnClear; r++)
      for (let c = sc - CAVE.spawnClear; c <= sc + CAVE.spawnClear; c++) if (c >= 0 && c < COLS && r >= 0 && r < ROWS) g[idx(c, r)] = 0;
  // 出現位置1からたどれない床は壁で埋める。ほかの出現位置にたどれなければ作り直す
  const seen = new Uint8Array(COLS * ROWS);
  const stack = [idx(spawnCells[0][0], spawnCells[0][1])];
  seen[stack[0]] = 1;
  let open = 0;
  while (stack.length) {
    const i = stack.pop()!;
    open++;
    const c = i % COLS;
    const r = (i - c) / COLS;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || cc >= COLS || rr < 0 || rr >= ROWS) continue;
      const j = idx(cc, rr);
      if (g[j] || seen[j]) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  if (spawnCells.some(([c, r]) => !seen[idx(c, r)])) return null;
  for (let i = 0; i < g.length; i++) if (!g[i] && !seen[i]) g[i] = 1;
  const ratio = open / g.length;
  if (ratio < CAVE.openMin || ratio > CAVE.openMax) return null;
  return g;
}
