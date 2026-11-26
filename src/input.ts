import type { FrameInput } from './game';

import { bindings, lastDevice, type Action } from './bindings';

/*
 * Reads keyboard + gamepad each frame using the player's bindings (see bindings.ts; remappable on
 * the Controls screen). Defaults: arrows or WASD fly, Z/J fire, X/K turn around, Space = tether /
 * refuel / shield (tap while carrying to drop the orb), Esc/P pause, R restart, M mute.
 * Gamepad: left stick tilts (and dives when pushed down), RT thrust, LT dive, A tether, X fire,
 * B turn around, Start pause, Select (Back) restart.
 * Dev-only extras (fixed): T tuning panel, E level editor, N next level, 1-9 jump to a level.
 */

const DEADZONE = 0.18;

export interface MetaInput {
  pause: boolean;
  toggleTuning: boolean;
  toggleMute: boolean;
  toggleEditor: boolean;
  nextLevel: boolean;
  /** 0-based level index from number keys 1-9, or -1. */
  jumpLevel: number;
}

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private prevPad: boolean[] = [];
  /** While the Controls screen is listening for a key, the game ignores the keyboard. */
  suspended = false;

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      if (isTextField(e.target) || this.suspended) return;
      lastDevice.kind = 'keys';
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
      // keep bound keys (and arrows/space/tab) from scrolling the page or moving focus
      if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab' || isBound(e.code)) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  /** Held: any of the action's keys. */
  private held(a: Action): boolean {
    return bindings[a].keys.some((c) => c && this.down.has(c));
  }

  /** Just pressed this frame: any of the action's keys. */
  private hit(a: Action): boolean {
    return bindings[a].keys.some((c) => c && this.pressed.has(c));
  }

  private p(...codes: string[]): boolean {
    return codes.some((c) => this.pressed.has(c));
  }

  /** Drop any keys pressed so far (e.g. the key that started the game shouldn't also fire). */
  flush(): void {
    this.pressed.clear();
    this.down.clear();
    const pad = firstGamepad();
    this.prevPad = pad ? pad.buttons.map((x) => x.pressed) : [];
  }

  poll(): { game: FrameInput; meta: MetaInput } {
    let tiltAxis = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    let rotor = this.held('rotor') ? 1 : 0;
    let dive = this.held('dive') ? 1 : 0;
    let fire = this.held('fire');
    let flip = this.hit('flip');
    let pickup = this.held('beam');
    let pickupPressed = this.hit('beam');
    let restart = this.hit('restart');
    let pause = this.hit('pause') || this.p('Tab');
    let toggleMute = this.hit('mute');
    const toggleTuning = this.p('KeyT', 'Backquote');
    const toggleEditor = this.p('KeyE');
    const nextLevel = this.p('KeyN');
    let jumpLevel = -1;
    for (let i = 1; i <= 9; i++) if (this.p(`Digit${i}`)) jumpLevel = i - 1;

    const pad = firstGamepad();
    if (pad) {
      const pressedNow = (i: number) => i >= 0 && !!pad.buttons[i]?.pressed;
      const value = (i: number) => (i >= 0 ? (pad.buttons[i]?.value ?? 0) : 0);
      const edge = (i: number) => pressedNow(i) && !this.prevPad[i];
      const pb = (a: Action) => bindings[a].pad;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const stick = Math.abs(ax) > DEADZONE ? Math.sign(ax) * ((Math.abs(ax) - DEADZONE) / (1 - DEADZONE)) : 0;
      const stickDown = ay > DEADZONE ? (ay - DEADZONE) / (1 - DEADZONE) : 0;
      const padTilt = stick + (pressedNow(pb('right')) ? 1 : 0) - (pressedNow(pb('left')) ? 1 : 0);
      const used = Math.abs(stick) > 0 || stickDown > 0 || pad.buttons.some((x) => x.pressed);
      if (used) lastDevice.kind = 'pad';
      tiltAxis += padTilt;
      rotor = Math.max(rotor, value(pb('rotor')));
      dive = Math.max(dive, value(pb('dive')), stickDown);
      fire ||= pressedNow(pb('fire'));
      flip ||= edge(pb('flip'));
      pickup ||= pressedNow(pb('beam'));
      pickupPressed ||= edge(pb('beam'));
      restart ||= edge(pb('restart'));
      pause ||= edge(pb('pause'));
      toggleMute ||= edge(pb('mute'));
      this.prevPad = pad.buttons.map((x) => x.pressed);
    }

    this.pressed.clear();
    tiltAxis = Math.max(-1, Math.min(1, tiltAxis));
    return {
      game: { tiltAxis, rotor, dive, fire, flip, pickup, pickupPressed, restart },
      meta: { pause, toggleTuning, toggleMute, toggleEditor, nextLevel, jumpLevel },
    };
  }
}

function isBound(code: string): boolean {
  return Object.values(bindings).some((b) => b.keys.includes(code));
}

export function firstGamepad(): Gamepad | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  for (const g of navigator.getGamepads()) if (g && g.connected) return g;
  return null;
}

function isTextField(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}
