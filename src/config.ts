export const ARENA = { width: 1280, height: 720, wall: 20 };

export const PLAYER = { radius: 14, speed: 250, maxHp: 5, invincible: 1.0 };

export type EnemyKind = 'grunt' | 'runner' | 'tank';

export const ENEMY_KINDS: Record<EnemyKind, { r: number; hp: number; speed: number; xp: number; color: number }> = {
  grunt: { r: 13, hp: 1, speed: 80, xp: 1, color: 0xff5a5a },
  runner: { r: 10, hp: 1, speed: 145, xp: 1, color: 0xffa53a },
  tank: { r: 24, hp: 8, speed: 50, xp: 5, color: 0xb76bff },
};

export const SPAWN = {
  telegraph: 0.7, // 出現予告の秒数
  minDistFromPlayer: 220,
  maxEnemies: 140,
  /** 経過秒数 → 次の出現までの秒数 */
  interval: (t: number) => Math.max(0.18, 1.1 * Math.pow(0.985, t)),
  /** 経過秒数 → 1回の出現数 */
  batch: (t: number) => 1 + Math.floor(t / 45),
  /** 経過秒数 → HP倍率 */
  hpScale: (t: number) => 1 + t / 90,
  pickKind: (t: number): EnemyKind => {
    const r = Math.random();
    if (t > 60 && r < 0.12) return 'tank';
    if (t > 30 && r < 0.35) return 'runner';
    return 'grunt';
  },
};

export const LIMITS = { bullets: 10000, particles: 500 };

/** level → 次のレベルまでの必要経験値 */
export const xpToNext = (level: number) => 4 + level * 4;
