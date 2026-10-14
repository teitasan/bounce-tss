export type AbilityId = 'multi' | 'big' | 'speed' | 'bounce' | 'pierce' | 'homing' | 'split' | 'range' | 'rapid' | 'shatter' | 'charge' | 'explode';

export interface AbilityDef {
  id: AbilityId;
  name: string;
  max: number;
  /** level（1以上）になったときの効果説明 */
  describe: (level: number) => string;
}

const PIERCE = [0, 1, 2, 3];
const HOMING_TURN = [0, 2, 3.5, 5]; // rad/s
const HOMING_RANGE = [0, 220, 300, 380];
const SPLIT_DEPTH = [0, 1, 2, 3];
const LIFE = [1.0, 1.5, 2.1, 2.8]; // 弾の寿命（秒）
const FIRE_INTERVAL = [0.2, 0.16, 0.13, 0.1]; // 秒
const SHATTER = [0, 2, 3, 4]; // 命中時に出る破片の数
const CHARGE = [0, 0.5, 1, 1.5]; // 反射1回ごとの威力の加算
const EXPLODE_RADIUS = [0, 30, 40, 50];
const EXPLODE_DAMAGE = 0.5; // 雑魚（HP1）は爆発2回で倒れる
const EXPLODE_CHAIN = [0, 0, 1, 2]; // 爆発で倒した敵がさらに爆発できる回数

export const ABILITIES: AbilityDef[] = [
  { id: 'multi', name: '弾数増加', max: 2, describe: (n) => `${n + 1}way で発射` },
  { id: 'big', name: '巨大化', max: 3, describe: (n) => `弾の大きさ ×${(1 + 0.4 * n).toFixed(1)}` },
  { id: 'speed', name: '高速化', max: 3, describe: (n) => `弾速 ×${(1 + 0.25 * n).toFixed(2)}` },
  { id: 'bounce', name: '跳弾強化', max: 3, describe: (n) => `壁で ${1 + n} 回まで反射` },
  { id: 'range', name: '射程延長', max: 3, describe: (n) => `弾の寿命 ${LIFE[0]}秒 → ${LIFE[n]}秒` },
  {
    id: 'pierce',
    name: '貫通',
    max: 3,
    describe: (n) => `敵を ${PIERCE[n]} 体貫通`,
  },
  { id: 'homing', name: 'ホーミング', max: 3, describe: (n) => `敵を追尾（追尾力 ${['', '弱', '中', '強'][n]}）` },
  { id: 'rapid', name: '連射速度', max: 3, describe: (n) => `毎秒 ${(1 / FIRE_INTERVAL[0]).toFixed(0)}発 → ${(1 / FIRE_INTERVAL[n]).toFixed(0)}発` },
  { id: 'shatter', name: '命中拡散', max: 3, describe: (n) => `命中した場所から破片が ${SHATTER[n]} 発飛び散る` },
  { id: 'charge', name: '反射チャージ', max: 3, describe: (n) => `壁で反射するたびに威力 +${CHARGE[n]}` },
  {
    id: 'explode',
    name: '誘爆',
    max: 3,
    describe: (n) =>
      `倒した敵が爆発（半径 ${EXPLODE_RADIUS[n]}・威力 ${EXPLODE_DAMAGE}）` + (EXPLODE_CHAIN[n] > 0 ? `。爆発で倒した敵も ${EXPLODE_CHAIN[n]} 段まで連鎖` : ''),
  },
  {
    id: 'split',
    name: '反射分裂',
    max: 3,
    describe: (n) => `反射時に小さな子弾を1発飛ばす（1発につき最大 ${SPLIT_DEPTH[n]} 回）`,
  },
];

export const ABILITY_BY_ID = Object.fromEntries(ABILITIES.map((a) => [a.id, a])) as Record<AbilityId, AbilityDef>;

export type Build = Record<AbilityId, number>;

export function emptyBuild(): Build {
  return { multi: 0, big: 0, speed: 0, bounce: 0, pierce: 0, homing: 0, split: 0, range: 0, rapid: 0, shatter: 0, charge: 0, explode: 0 };
}

export interface BulletStats {
  ways: number;
  spread: number; // way 間の角度（rad）
  radius: number;
  speed: number;
  bounces: number;
  pierce: number;
  homingTurn: number;
  homingRange: number;
  splitDepth: number;
  splitAngle: number; // 子弾が親弾からずれる角度（rad）
  childLife: number; // 子弾の寿命（秒）
  shards: number;
  shardLife: number;
  chargePerBounce: number;
  explodeRadius: number;
  explodeChain: number;
  explodeDamage: number;
  damage: number;
  fireInterval: number;
  life: number;
}

export function statsFor(b: Build): BulletStats {
  const bounces = 1 + b.bounce;
  return {
    ways: 1 + b.multi,
    spread: 0.16,
    radius: 5 * (1 + 0.4 * b.big),
    speed: 520 * (1 + 0.25 * b.speed),
    bounces,
    pierce: PIERCE[b.pierce],
    homingTurn: HOMING_TURN[b.homing],
    homingRange: HOMING_RANGE[b.homing],
    splitDepth: SPLIT_DEPTH[b.split],
    splitAngle: 0.45,
    childLife: 1.2,
    shards: SHATTER[b.shatter],
    shardLife: 0.45,
    chargePerBounce: CHARGE[b.charge],
    explodeRadius: EXPLODE_RADIUS[b.explode],
    explodeChain: EXPLODE_CHAIN[b.explode],
    explodeDamage: EXPLODE_DAMAGE,
    damage: 1,
    fireInterval: FIRE_INTERVAL[b.rapid],
    life: LIFE[b.range],
  };
}
