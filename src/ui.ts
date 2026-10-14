import { ABILITIES, type AbilityDef, type AbilityId, type Build } from './abilities';

const $ = (id: string) => document.getElementById(id)!;

export interface Choice {
  def: AbilityDef;
  next: number;
}

export interface HudState {
  level: number;
  xp: number;
  need: number;
  hp: number;
  maxHp: number;
  time: number;
  kills: number;
  bullets: number;
  enemies: number;
}

export interface DebugHooks {
  getBuild: () => Build;
  setLevel: (id: AbilityId, level: number) => void;
  toggles: { label: string; get: () => boolean; set: (v: boolean) => void }[];
  actions: { label: string; run: () => void }[];
}

const pips = (level: number, max: number) => '●'.repeat(level) + '○'.repeat(max - level);

class Ui {
  private modalKeys: ((e: KeyboardEvent) => void) | null = null;
  private debugHooks: DebugHooks | null = null;

  hud(s: HudState) {
    $('lv').textContent = `Lv ${s.level}`;
    ($('xpfill') as HTMLElement).style.width = `${Math.min(100, (s.xp / s.need) * 100)}%`;
    $('hp').textContent = '♥'.repeat(Math.max(0, s.hp)) + '♡'.repeat(Math.max(0, s.maxHp - s.hp));
    const m = Math.floor(s.time / 60);
    const sec = Math.floor(s.time % 60).toString().padStart(2, '0');
    $('info').textContent = `${m}:${sec}　撃破 ${s.kills}　弾 ${s.bullets}　敵 ${s.enemies}`;
  }

  build(b: Build) {
    const owned = ABILITIES.filter((a) => b[a.id] > 0);
    $('build').innerHTML = owned.length
      ? owned.map((a) => `<div><span>${a.name}</span><span class="pips">${pips(b[a.id], a.max)}</span></div>`).join('')
      : '<div class="muted">能力なし</div>';
    if (!$('debug').hidden) this.renderDebug();
  }

  showLevelUp(choices: Choice[], pick: (id: AbilityId) => void) {
    const box = $('choices');
    box.innerHTML = '';
    const done = (id: AbilityId) => {
      this.hide('levelup');
      pick(id);
    };
    choices.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice';
      btn.innerHTML = `<span class="key">${i + 1}</span><strong>${c.def.name}</strong><span class="lvl">Lv ${c.next} / ${c.def.max}</span><span class="desc">${c.def.describe(c.next)}</span>`;
      btn.addEventListener('click', () => done(c.def.id));
      box.appendChild(btn);
    });
    this.show('levelup', (e) => {
      const i = Number(e.key) - 1;
      if (choices[i]) done(choices[i].def.id);
    });
  }

  showGameOver(lines: [string, string][], restart: () => void) {
    $('result').innerHTML = lines.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const btn = $('restart') as HTMLButtonElement;
    const done = () => {
      this.hide('gameover');
      restart();
    };
    btn.onclick = done;
    this.show('gameover', (e) => {
      if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') done();
    });
  }

  setPaused(paused: boolean) {
    $('paused').hidden = !paused;
  }

  isModalOpen() {
    return this.modalKeys !== null;
  }

  // ---- デバッグパネル（Tab） ----
  setupDebug(hooks: DebugHooks) {
    this.debugHooks = hooks;
  }

  toggleDebug() {
    const el = $('debug');
    el.hidden = !el.hidden;
    if (!el.hidden) this.renderDebug();
  }

  private renderDebug() {
    const h = this.debugHooks;
    if (!h) return;
    const el = $('debug');
    const b = h.getBuild();
    el.innerHTML = '<h3>デバッグ（Tab で閉じる）</h3>';
    for (const a of ABILITIES) {
      const row = document.createElement('div');
      row.className = 'drow';
      row.innerHTML = `<span>${a.name}</span><button type="button">−</button><span class="pips">${pips(b[a.id], a.max)}</span><button type="button">＋</button>`;
      const [minus, plus] = row.querySelectorAll('button');
      minus.onclick = () => h.setLevel(a.id, Math.max(0, b[a.id] - 1));
      plus.onclick = () => h.setLevel(a.id, Math.min(a.max, b[a.id] + 1));
      el.appendChild(row);
    }
    for (const t of h.toggles) {
      const label = document.createElement('label');
      label.className = 'drow';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = t.get();
      cb.onchange = () => t.set(cb.checked);
      label.append(cb, ` ${t.label}`);
      el.appendChild(label);
    }
    const acts = document.createElement('div');
    acts.className = 'dacts';
    for (const a of h.actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = a.label;
      btn.onclick = a.run;
      acts.appendChild(btn);
    }
    el.appendChild(acts);
  }

  private show(id: string, onKey: (e: KeyboardEvent) => void) {
    $(id).hidden = false;
    this.modalKeys = onKey;
    window.addEventListener('keydown', onKey);
  }

  private hide(id: string) {
    $(id).hidden = true;
    if (this.modalKeys) window.removeEventListener('keydown', this.modalKeys);
    this.modalKeys = null;
  }
}

export const ui = new Ui();
