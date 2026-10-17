import * as Phaser from 'phaser';
import { ARENA, PIXEL } from './config';
import { GameScene } from './GameScene';
import { ShellScene } from './shell/ShellScene';
import './style.css';

type Mode = 'rogue' | 'shell' | 'cards' | 'custom' | 'craft';
const SCENE_OF: Record<Mode, string> = { rogue: 'game', shell: 'shell', cards: 'cards', custom: 'custom', craft: 'craft' };
const isMode = (v: unknown): v is Mode => v === 'rogue' || v === 'shell' || v === 'cards' || v === 'custom' || v === 'craft';

/** 前回選んだモードがなければカスタム甲羅（今のメイン）で始める */
const DEFAULT_MODE: Mode = 'custom';

const readMode = (): Mode => {
  try {
    const v = localStorage.getItem('tss-mode');
    return isMode(v) ? v : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
};

// ?r=部屋名 付きの URL で開いたら、オンライン対戦のあるカスタム甲羅で始める
let mode: Mode = new URLSearchParams(location.search).get('r') ? 'custom' : readMode();

/** body にモードのクラスを付ける。甲羅のモードは試合場の上下にプレイヤーの帯があり、ゲーム画面の大きさが変わる */
function setBodyMode() {
  for (const m of ['rogue', 'shell', 'cards', 'custom', 'craft'] as Mode[]) document.body.classList.toggle(`mode-${m}`, mode === m);
}
// ゲームを作る前に付けておき、最初から帯を除いた大きさで画面を合わせる
setBodyMode();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: ARENA.width / PIXEL,
  height: ARENA.height / PIXEL,
  backgroundColor: '#0a0d13',
  antialias: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [],
});

game.scene.add('game', GameScene, mode === 'rogue');
game.scene.add('shell', new ShellScene('shell', 'plain'), mode === 'shell');
game.scene.add('cards', new ShellScene('cards', 'cards'), mode === 'cards');
game.scene.add('custom', new ShellScene('custom', 'custom'), mode === 'custom');
game.scene.add('craft', new ShellScene('craft', 'craft'), mode === 'craft');

/**
 * ゲーム画面を親（帯の間）の大きさに合わせ直す。帯の有無はモードで変わる。
 * Phaser は1回目で親の大きさだけ読み直し、画面の大きさに反映するのは次の呼び出しなので2回呼ぶ
 */
function fitGame() {
  game.scale.refresh();
  game.scale.refresh();
}
game.events.once('ready', fitGame);
// ウィンドウの大きさが変わったときも、Phaser 任せだと1回前の大きさのままになることがあるので、
// ゲーム画面の入れ物（帯の間）の大きさが変わるたびに合わせ直す
new ResizeObserver(fitGame).observe(document.getElementById('game')!);

function applyMode() {
  setBodyMode();
  document.querySelectorAll<HTMLButtonElement>('#modebar button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  fitGame();
}

function switchMode(next: Mode) {
  if (next === mode) return;
  // 離れたモードは止めずに眠らせ、戻ったときに続きから遊べるようにする
  game.scene.sleep(SCENE_OF[mode]);
  mode = next;
  game.scene.run(SCENE_OF[mode]);
  try {
    localStorage.setItem('tss-mode', mode);
  } catch {
    /* 保存できなくても動作には影響しない */
  }
  applyMode();
}

document.querySelectorAll<HTMLButtonElement>('#modebar button').forEach((b) => {
  b.addEventListener('click', () => {
    b.blur(); // Space で再度押されないように
    switchMode(b.dataset.mode as Mode);
  });
});
applyMode();

// GitHub Pages 版は部屋サーバーがないので、オンライン対戦のボタンを出さない
if (import.meta.env.VITE_OFFLINE_ONLY === '1') document.getElementById('online-btn')?.remove();

if (import.meta.env.DEV) Object.assign(window, { __game: game });
