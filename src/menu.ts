import { ACTIONS, bindKey, bindings, bindPad, keyName, padName, resetBindings, saveBindings, type Action } from './bindings';
import { firstGamepad } from './input';

/*
 * Front page (PLAY, starting level, CONTROLS) and the Controls screen, as an HTML overlay over the game canvas
 * (the first level idles behind it). The Controls screen lists every action with two keyboard
 * slots and a gamepad slot: click a slot, then press the key or gamepad button you want.
 * Mouse, keyboard (arrows/Enter) and gamepad (d-pad/A, B for back) all work in the menus.
 */

type Screen = 'title' | 'controls' | null;

export class Menu {
  screen: Screen = 'title';
  /** Set by main.ts: start the game at this level (0-based). */
  onPlay: ((level: number) => void) | null = null;
  /** The starting level picked on the front page (0-based). */
  level = 0;
  /** Set by main.ts: the Controls screen is listening for a key (the game should ignore keys). */
  onListening: ((on: boolean) => void) | null = null;

  private root: HTMLDivElement;
  private listen: { action: Action; slot: 0 | 1 | 'pad' } | null = null;
  private padBaseline: boolean[] = [];
  private prevPad: boolean[] = [];
  private prevAxis = { x: 0, y: 0 };
  private note = '';
  private focus = 0;

  constructor(private levelNames: string[]) {
    this.root = document.createElement('div');
    this.root.className = 'menu';
    document.body.append(this.root);
    injectStyles();
    addEventListener('keydown', (e) => this.onKey(e), true);
    this.show('title');
  }

  get open(): boolean {
    return this.screen !== null;
  }

  show(s: Screen): void {
    this.screen = s;
    this.listen = null;
    this.note = '';
    this.focus = 0;
    this.onListening?.(false);
    const pad = firstGamepad();
    this.prevPad = pad ? pad.buttons.map((b) => b.pressed) : [];
    this.build();
  }

  hide(): void {
    this.show(null);
  }

  /** Called every frame while open: gamepad navigation and gamepad rebinding. */
  frame(): void {
    if (!this.open) return;
    const pad = firstGamepad();
    if (!pad) return;
    const now = pad.buttons.map((b) => b.pressed);
    const edge = (i: number) => !!now[i] && !this.prevPad[i];
    if (this.listen) {
      // rebinding: the first button that wasn't already held when we started listening
      const i = now.findIndex((p, k) => p && !this.padBaseline[k]);
      if (i >= 0 && this.listen.slot === 'pad') this.assignPad(this.listen.action, i);
      this.padBaseline = this.padBaseline.map((b, k) => b && !!now[k]);
    } else {
      // navigate: d-pad or stick up/down, A to choose, B to go back
      const ay = pad.axes[1] ?? 0;
      const up = edge(12) || (ay < -0.6 && this.prevAxis.y >= -0.6);
      const down = edge(13) || (ay > 0.6 && this.prevAxis.y <= 0.6);
      const ax = pad.axes[0] ?? 0;
      const left = edge(14) || (ax < -0.6 && this.prevAxis.x >= -0.6);
      const right = edge(15) || (ax > 0.6 && this.prevAxis.x <= 0.6);
      if (up) this.move(-1);
      if (down) this.move(1);
      if (left) this.side(-1);
      if (right) this.side(1);
      if (edge(0) || (this.screen === 'title' && edge(9))) this.activate();
      if (edge(1) && this.screen === 'controls') this.show('title');
      this.prevAxis = { x: pad.axes[0] ?? 0, y: ay };
    }
    this.prevPad = now;
  }

  // ------------------------------------------------------------------ keyboard

  private onKey(e: KeyboardEvent): void {
    if (!this.open) return;
    if (this.listen) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.listen.slot === 'pad') {
        if (e.code === 'Escape') this.stopListening('');
        return;
      }
      if (e.code === 'Escape') return this.stopListening('');
      this.assignKey(this.listen.action, this.listen.slot, e.code);
      return;
    }
    // menu navigation (the game doesn't see these keys while a menu is open)
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', 'Escape', 'Tab'].includes(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (e.code === 'ArrowUp' || (e.code === 'Tab' && e.shiftKey)) this.move(-1);
    else if (e.code === 'ArrowDown' || e.code === 'Tab') this.move(1);
    else if (e.code === 'ArrowLeft') this.side(-1);
    else if (e.code === 'ArrowRight') this.side(1);
    else if (e.code === 'Enter' || e.code === 'Space') this.activate();
    else if (e.code === 'Escape' && this.screen === 'controls') this.show('title');
  }

  private focusables(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>('[data-nav]')];
  }

  private move(d: number): void {
    const els = this.focusables();
    if (!els.length) return;
    this.focus = (this.focus + d + els.length) % els.length;
    this.paintFocus();
  }

  /** Left/right: change the starting level when the level picker is focused. */
  private side(d: number): void {
    if (this.screen !== 'title' || !this.focusables()[this.focus]?.classList.contains('menu-level')) return;
    this.pickLevel(d);
  }

  private pickLevel(d: number): void {
    const n = this.levelNames.length;
    this.level = (this.level + d + n) % n;
    this.build();
  }

  private activate(): void {
    this.focusables()[this.focus]?.click();
  }

  private paintFocus(): void {
    this.focusables().forEach((el, i) => el.classList.toggle('focus', i === this.focus));
    this.focusables()[this.focus]?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ rebinding

  private startListening(action: Action, slot: 0 | 1 | 'pad'): void {
    this.listen = { action, slot };
    this.note = slot === 'pad' ? 'Press a gamepad button… (Esc to cancel)' : 'Press a key… (Esc to cancel)';
    const pad = firstGamepad();
    this.padBaseline = pad ? pad.buttons.map((b) => b.pressed) : [];
    this.onListening?.(true);
    this.build();
  }

  private stopListening(note: string): void {
    this.listen = null;
    this.note = note;
    this.onListening?.(false);
    // the button that was just pressed shouldn't also act on the menu
    const pad = firstGamepad();
    this.prevPad = pad ? pad.buttons.map((b) => b.pressed) : [];
    this.build();
  }

  private assignKey(action: Action, slot: 0 | 1, code: string): void {
    const from = bindKey(bindings, action, slot, code);
    saveBindings();
    this.stopListening(from ? `${keyName(code)} moved here from “${label(from)}”.` : '');
  }

  private assignPad(action: Action, button: number): void {
    const from = bindPad(bindings, action, button);
    saveBindings();
    this.stopListening(from ? `${padName(button)} moved here from “${label(from)}”.` : '');
  }

  // ------------------------------------------------------------------ screens

  private build(): void {
    this.root.style.display = this.screen ? '' : 'none';
    if (!this.screen) return this.root.replaceChildren();
    const keepFocus = this.focus;
    if (this.screen === 'title') this.buildTitle();
    else this.buildControls();
    this.focus = Math.min(keepFocus, Math.max(0, this.focusables().length - 1));
    this.paintFocus();
  }

  private buildTitle(): void {
    const play = button('PLAY', 'big', () => {
      this.hide();
      this.onPlay?.(this.level);
    });
    // starting level: ◀ LEVEL 2 · NAME ▶ (click the arrows, or left/right when it's focused)
    const prev = el('span', { class: 'menu-arrow' }, '◀');
    const next = el('span', { class: 'menu-arrow' }, '▶');
    prev.onclick = (e) => {
      e.stopPropagation();
      this.pickLevel(-1);
    };
    next.onclick = (e) => {
      e.stopPropagation();
      this.pickLevel(1);
    };
    const picker = el(
      'button',
      { class: 'menu-level', 'data-nav': '' },
      prev,
      el('span', { class: 'menu-level-name' }, `LEVEL ${this.level + 1} · ${this.levelNames[this.level] ?? ''}`),
      next,
    );
    picker.onclick = () => this.pickLevel(1);
    const controls = button('CONTROLS', 'big', () => this.show('controls'));
    this.root.replaceChildren(
      el(
        'div',
        { class: 'menu-title-screen' },
        el('h1', { class: 'menu-logo' }, 'THRUSTLIFTER'),
        el('div', { class: 'menu-buttons' }, play, picker, controls),
        el('div', { class: 'menu-hint' }, firstGamepad() ? 'Gamepad connected' : 'Keyboard or gamepad'),
      ),
    );
  }

  private buildControls(): void {
    const rows = ACTIONS.map((a) => {
      const b = bindings[a.id];
      const slot = (s: 0 | 1 | 'pad') => {
        const listening = this.listen?.action === a.id && this.listen.slot === s;
        const text = listening ? '…' : s === 'pad' ? padName(b.pad) || '—' : keyName(b.keys[s]) || '—';
        const btn = button(text, `slot${listening ? ' listening' : ''}${s === 'pad' ? ' pad' : ''}`, () => this.startListening(a.id, s));
        btn.title = s === 'pad' ? 'Click, then press a gamepad button' : 'Click, then press a key';
        return btn;
      };
      return el(
        'div',
        { class: 'menu-row' },
        el('div', { class: 'menu-action' }, a.label, a.note ? el('div', { class: 'menu-note' }, a.note) : ''),
        slot(0),
        slot(1),
        slot('pad'),
      );
    });
    this.root.replaceChildren(
      el(
        'div',
        { class: 'menu-panel' },
        el('h2', {}, 'CONTROLS'),
        el('div', { class: 'menu-row menu-head' }, el('div', {}, ''), el('div', {}, 'KEY'), el('div', {}, 'ALT KEY'), el('div', {}, 'GAMEPAD')),
        ...rows,
        el('div', { class: 'menu-note menu-fixed' }, 'Gamepad: the left stick always tilts, and pushing it down dives. Triggers work as analog thrust and dive.'),
        el('div', { class: 'menu-status' }, this.note),
        el(
          'div',
          { class: 'menu-buttons row' },
          button('RESET TO DEFAULTS', '', () => {
            resetBindings();
            this.note = 'Controls reset to the defaults.';
            this.build();
          }),
          button('BACK', '', () => this.show('title')),
        ),
      ),
    );
  }
}

function label(a: Action): string {
  return ACTIONS.find((x) => x.id === a)!.label;
}

function button(text: string, cls: string, fn: () => void): HTMLElement {
  const b = el('button', { class: cls, 'data-nav': '' }, text);
  b.onclick = (e) => {
    e.preventDefault();
    fn();
  };
  return b;
}

function el(tag: string, attrs: Record<string, string>, ...kids: (string | Node)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

function injectStyles(): void {
  if (document.getElementById('menu-styles')) return;
  const s = document.createElement('style');
  s.id = 'menu-styles';
  s.textContent = `
  .menu { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(ellipse at center, rgba(4,3,12,0.35), rgba(4,3,12,0.82));
    font: 16px ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #cfe9ff; }
  .menu button { font: inherit; color: inherit; cursor: pointer; background: rgba(8,6,24,0.7);
    border: 1px solid rgba(90,252,255,0.35); border-radius: 6px; padding: 8px 14px; letter-spacing: 1px; }
  .menu button:hover, .menu button.focus { background: rgba(90,252,255,0.16); border-color: #5afcff; color: #fff;
    box-shadow: 0 0 14px rgba(90,252,255,0.35); outline: none; }
  .menu-title-screen { text-align: center; }
  .menu-logo { margin: 0 0 48px; font-size: clamp(40px, 9vw, 110px); letter-spacing: 6px; color: #ffd23f;
    text-shadow: 0 0 18px rgba(255,210,63,0.75), 0 0 48px rgba(255,61,242,0.45); }
  .menu-buttons { display: flex; flex-direction: column; gap: 14px; align-items: center; }
  .menu-buttons.row { flex-direction: row; justify-content: center; margin-top: 14px; }
  .menu button.big { min-width: 280px; font-size: 26px; font-weight: bold; padding: 12px 24px; letter-spacing: 4px; }
  .menu button.menu-level { min-width: 280px; display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #9fe8ff; }
  .menu-arrow { color: #ffd23f; padding: 0 6px; }
  .menu-arrow:hover { color: #fff; }
  .menu-level-name { flex: 1; text-align: center; }
  .menu-hint { margin-top: 36px; color: rgba(207,233,255,0.5); font-size: 13px; }
  .menu-panel { background: rgba(6,5,20,0.88); border: 1px solid rgba(90,252,255,0.3); border-radius: 10px;
    padding: 22px 26px; max-height: 92vh; overflow-y: auto; box-shadow: 0 0 30px rgba(90,252,255,0.12); }
  .menu-panel h2 { margin: 0 0 14px; text-align: center; color: #ffd23f; letter-spacing: 5px; text-shadow: 0 0 12px rgba(255,210,63,0.6); }
  .menu-row { display: grid; grid-template-columns: 260px 110px 110px 120px; gap: 8px; align-items: center; margin: 6px 0; }
  .menu-head { color: rgba(207,233,255,0.55); font-size: 12px; letter-spacing: 2px; margin-bottom: 2px; }
  .menu-head > div { text-align: center; } .menu-head > div:first-child { text-align: left; }
  .menu-action { font-weight: bold; }
  .menu-note { font-weight: normal; font-size: 12px; color: rgba(207,233,255,0.55); margin-top: 2px; }
  .menu-fixed { margin-top: 12px; text-align: center; }
  .menu button.slot { padding: 6px 4px; color: #7dffb0; }
  .menu button.slot.pad { color: #ffd23f; }
  .menu button.slot.listening { background: rgba(255,210,63,0.25); border-color: #ffd23f; color: #fff; animation: menu-blink 0.6s infinite alternate; }
  @keyframes menu-blink { from { opacity: 1; } to { opacity: 0.45; } }
  .menu-status { min-height: 20px; margin-top: 10px; text-align: center; color: #ffcf66; }
  `;
  document.head.append(s);
}
