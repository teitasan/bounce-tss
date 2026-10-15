// ピザのお試しページ（pizza-preview.html）。開発時の見比べ用で、ゲーム本体には含めない
/* eslint-disable */
// @ts-nocheck
import { pizzaSvg, TOPPINGS } from './shell/pizza';
import { EFFECTS, EFFECT_IDS } from './shell/custom';

const cell = (lv, label, sub = '', size = 96) => `<div class="cell">${pizzaSvg(lv, size)}<span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
document.getElementById('plain').innerHTML = cell({}, '緑甲羅にあたる基本のピザ', '', 140);

document.getElementById('each').innerHTML = EFFECT_IDS.map(
  (e) => cell({ [e]: 1 }, `${EFFECTS[e].name} Lv1`, TOPPINGS[e].name) + cell({ [e]: 3 }, `${EFFECTS[e].name} Lv3`, TOPPINGS[e].name),
).join('');

const combos = [
  [{ homing: 2, pierce: 1 }, '追尾2・貫通1'],
  [{ split: 1, rebound: 1 }, '分裂1・反発1'],
  [{ multi: 1, big: 2 }, '拡散1・巨大化2'],
  [{ bounce: 2, accel: 1, fast: 1 }, '跳弾2・加速1・高速化1'],
  [{ homing: 1, split: 1, pierce: 1, rebound: 1, bounce: 1, accel: 1, big: 1, fast: 1 }, '全部 Lv1'],
  [{ homing: 3, pierce: 3, bounce: 3 }, '追尾3・貫通3・跳弾3'],
];
document.getElementById('combo').innerHTML = combos.map(([lv, t]) => cell(lv, t, '', 120)).join('');

const samples = [{}, { homing: 1 }, { pierce: 2 }, { split: 1, rebound: 1 }, { multi: 1 }, { bounce: 2, accel: 1 }, { big: 2 }];
const names = ['強化なし', '追尾1', '貫通2', '分裂1・反発1', '拡散1', '跳弾2・加速1', '巨大化2'];
document.getElementById('sizes').innerHTML =
  `<div class="row" style="margin-bottom:8px"><b></b>${names.map((n) => `<span style="width:44px;font-size:10px;color:#8492ad;text-align:center">${n}</span>`).join('')}</div>` +
  [22, 26, 34, 44]
    .map(
      (sz) =>
        `<div class="row" style="margin-bottom:4px"><b>${sz}px 細かい</b>${samples.map((lv) => `<span style="width:44px;display:grid;place-items:center">${pizzaSvg(lv, sz, false)}</span>`).join('')}</div>` +
        `<div class="row" style="margin-bottom:10px"><b>${sz}px 簡略</b>${samples.map((lv) => `<span style="width:44px;display:grid;place-items:center">${pizzaSvg(lv, sz, true)}</span>`).join('')}</div>`,
    )
    .join('');

const orbit = [{ homing: 1 }, { split: 1, pierce: 1 }, { bounce: 2 }];
document.getElementById('orbit').innerHTML = orbit
  .map((lv, i) => {
    const a = (i / 3) * Math.PI * 2;
    return `<div style="left:${Math.cos(a) * 32}px;top:${Math.sin(a) * 32}px">${pizzaSvg(lv, 26)}</div>`;
  })
  .join('');
document.getElementById('fly').innerHTML = pizzaSvg({ homing: 2, pierce: 1 }, 30);
