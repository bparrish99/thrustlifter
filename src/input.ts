import type { FrameInput } from './game';

/*
 * Keyboard (two layouts work at once):
 *   Arrows: ←/→ tilt, ↑ rotor, ↓ dive   with  Z missile, X bomb, C flip
 *   WASD:   A/D tilt, W rotor, S dive   with  J missile, K bomb, L flip
 *   Space   hold = tether (pick up orb); press while carrying = release
 *   R restart · P/Esc pause · T tuning panel · H help · M mute · N next level (after completing) · 1-9 jump to level
 *
 * Gamepad (standard mapping):
 *   Left stick X tilt · RT (analog) or A rotor · LT (analog) or stick down dive · X/RB missile · B bomb · Y flip
 *   LB tether · Start restart · Back pause
 */

const DEADZONE = 0.18;

export interface MetaInput {
  pause: boolean;
  toggleTuning: boolean;
  toggleHelp: boolean;
  toggleMute: boolean;
  nextLevel: boolean;
  /** 0-based level index from number keys 1-9, or -1. */
  jumpLevel: number;
}

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private prevPad: boolean[] = [];

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      if (isTextField(e.target)) return;
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  private k(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  private p(...codes: string[]): boolean {
    return codes.some((c) => this.pressed.has(c));
  }

  poll(): { game: FrameInput; meta: MetaInput } {
    let tiltAxis = (this.k('ArrowRight', 'KeyD') ? 1 : 0) - (this.k('ArrowLeft', 'KeyA') ? 1 : 0);
    let rotor = this.k('ArrowUp', 'KeyW') ? 1 : 0;
    let dive = this.k('ArrowDown', 'KeyS') ? 1 : 0;
    let fire = this.k('KeyZ', 'KeyJ');
    let bomb = this.k('KeyX', 'KeyK');
    let flip = this.p('KeyC', 'KeyL');
    let pickup = this.k('Space');
    let pickupPressed = this.p('Space');
    let restart = this.p('KeyR');
    let pause = this.p('KeyP', 'Escape');
    const toggleTuning = this.p('KeyT', 'Backquote');
    const toggleHelp = this.p('KeyH');
    const toggleMute = this.p('KeyM');
    const nextLevel = this.p('KeyN');
    let jumpLevel = -1;
    for (let i = 1; i <= 9; i++) if (this.p(`Digit${i}`)) jumpLevel = i - 1;

    const pad = firstGamepad();
    if (pad) {
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const edge = (i: number) => b(i) && !this.prevPad[i];
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > DEADZONE) tiltAxis += Math.sign(ax) * ((Math.abs(ax) - DEADZONE) / (1 - DEADZONE));
      rotor = Math.max(rotor, pad.buttons[7]?.value ?? 0, b(0) ? 1 : 0);
      const ay = pad.axes[1] ?? 0;
      dive = Math.max(dive, pad.buttons[6]?.value ?? 0, ay > DEADZONE ? (ay - DEADZONE) / (1 - DEADZONE) : 0);
      fire ||= b(2) || b(5);
      bomb ||= b(1);
      flip ||= edge(3);
      pickup ||= b(4);
      pickupPressed ||= edge(4);
      restart ||= edge(9);
      pause ||= edge(8);
      this.prevPad = pad.buttons.map((x) => x.pressed);
    }

    this.pressed.clear();
    tiltAxis = Math.max(-1, Math.min(1, tiltAxis));
    return {
      game: { tiltAxis, rotor, dive, fire, bomb, flip, pickup, pickupPressed, restart },
      meta: { pause, toggleTuning, toggleHelp, toggleMute, nextLevel, jumpLevel },
    };
  }
}

function firstGamepad(): Gamepad | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  for (const g of navigator.getGamepads()) if (g && g.connected) return g;
  return null;
}

function isTextField(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}
