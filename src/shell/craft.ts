import type { EffectId } from './custom';
import type { Rect } from './arena';

/**
 * クラフト：試合場の箱を甲羅で壊すと素材が出る。拾うと今の甲羅に入り、同じ甲羅に2つ揃うと組み合わせの効果がその場で付く。
 * 作ったことのある組み合わせ（レシピ）は図鑑としてこの端末に保存する
 */
export type Material = 'feather' | 'eye' | 'stone' | 'spring';

export const MATERIALS: Record<Material, { name: string; color: number }> = {
  feather: { name: '羽', color: 0xe8f4ff },
  eye: { name: '目玉', color: 0xff6b6b },
  stone: { name: '石', color: 0x9aa3b5 },
  spring: { name: 'バネ', color: 0xffd166 },
};
export const MATERIAL_IDS = Object.keys(MATERIALS) as Material[];

/** 2つの素材の組み合わせ → 付く効果（同じ効果が2つなら Lv が2上がる）。全10通り */
const RECIPE_LIST: [Material, Material, EffectId[]][] = [
  ['feather', 'feather', ['fast']],
  ['feather', 'eye', ['homing']],
  ['feather', 'stone', ['pierce']],
  ['feather', 'spring', ['accel']],
  ['eye', 'eye', ['homing', 'homing']],
  ['eye', 'stone', ['split']],
  ['eye', 'spring', ['multi']],
  ['stone', 'stone', ['big']],
  ['stone', 'spring', ['rebound']],
  ['spring', 'spring', ['bounce']],
];

export const recipeKey = (a: Material, b: Material) => [a, b].sort().join('+');
export const RECIPES = new Map(RECIPE_LIST.map(([a, b, eff]) => [recipeKey(a, b), { a, b, eff }]));

export const CRAFT = {
  crateSize: 36,
  crateHp: 1, // 甲羅が何回当たると壊れるか
  crateRespawn: 12, // 壊れてから同じ場所に戻るまでの秒数
  itemRadius: 10,
  pickupRadius: 26,
};

/** 箱の置き場所（左上の座標。試合場の中心について点対称） */
export const CRATE_SPOTS: { x: number; y: number }[] = (() => {
  const half = [
    { x: 420, y: 90 },
    { x: 160, y: 330 },
    { x: 500, y: 250 },
    { x: 620, y: 120 },
    { x: 400, y: 400 },
    { x: 1080, y: 200 },
  ];
  return [...half, ...half.map((p) => ({ x: 1280 - CRAFT.crateSize - p.x, y: 720 - CRAFT.crateSize - p.y }))];
})();

export interface Crate extends Rect {
  hp: number;
  /** 壊れていれば、戻るまでの残り秒数（0 なら置かれている） */
  respawn: number;
  /** 当たった瞬間の揺れ（秒） */
  shake: number;
}

export interface Item {
  id: number;
  kind: Material;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
}

const BOOK_KEY = 'tss-recipes';

/** 作ったことのあるレシピ（この端末に保存） */
export function loadBook(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(BOOK_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function saveBook(book: Set<string>) {
  try {
    localStorage.setItem(BOOK_KEY, JSON.stringify([...book]));
  } catch {
    /* 保存できなくても遊べる */
  }
}

export const randomMaterial = (): Material => MATERIAL_IDS[Math.floor(Math.random() * MATERIAL_IDS.length)];
