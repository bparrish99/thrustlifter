/*
 * Remappable controls: which keys and gamepad buttons drive each action. Players change these on
 * the Controls screen; they're saved in the browser. The left stick always tilts (and pushing it
 * down dives) whatever the button bindings are.
 */

export type Action = 'left' | 'right' | 'rotor' | 'dive' | 'fire' | 'flip' | 'beam' | 'pause' | 'restart' | 'mute';

export interface ActionInfo {
  id: Action;
  label: string;
  /** Shown under the label on the Controls screen. */
  note?: string;
}

export const ACTIONS: ActionInfo[] = [
  { id: 'rotor', label: 'Thrust (rotor)' },
  { id: 'left', label: 'Tilt left' },
  { id: 'right', label: 'Tilt right' },
  { id: 'dive', label: 'Dive' },
  { id: 'fire', label: 'Fire' },
  { id: 'flip', label: 'Turn around' },
  { id: 'beam', label: 'Tether · refuel · shield', note: 'hold; tap while carrying to drop the orb' },
  { id: 'pause', label: 'Pause' },
  { id: 'restart', label: 'Restart level' },
  { id: 'mute', label: 'Mute' },
];

export interface Binding {
  /** Up to two keyboard keys (KeyboardEvent.code), '' = unset. */
  keys: [string, string];
  /** A gamepad button (standard mapping index), or -1 = unset. Triggers work as analog. */
  pad: number;
}

export type Bindings = Record<Action, Binding>;

export const DEFAULT_BINDINGS: Bindings = {
  rotor: { keys: ['ArrowUp', 'KeyW'], pad: 7 }, // right trigger
  left: { keys: ['ArrowLeft', 'KeyA'], pad: 14 }, // d-pad left (the left stick always tilts too)
  right: { keys: ['ArrowRight', 'KeyD'], pad: 15 },
  dive: { keys: ['ArrowDown', 'KeyS'], pad: 6 }, // left trigger
  fire: { keys: ['KeyZ', 'KeyJ'], pad: 2 }, // X / Square
  flip: { keys: ['KeyX', 'KeyK'], pad: 1 }, // B / Circle
  beam: { keys: ['Space', ''], pad: 0 }, // A / Cross
  pause: { keys: ['Escape', 'KeyP'], pad: 9 }, // Start
  restart: { keys: ['KeyR', ''], pad: 8 }, // Select / Back / View
  mute: { keys: ['KeyM', ''], pad: -1 },
};

const STORAGE_KEY = 'thrustlifter.bindings.v1';

export function loadBindings(): Bindings {
  const b = structuredClone(DEFAULT_BINDINGS);
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return b;
    const saved = JSON.parse(raw) as Partial<Bindings>;
    for (const a of ACTIONS) {
      const s = saved[a.id];
      if (!s) continue;
      if (Array.isArray(s.keys)) b[a.id].keys = [String(s.keys[0] ?? ''), String(s.keys[1] ?? '')];
      if (typeof s.pad === 'number') b[a.id].pad = s.pad;
    }
  } catch {
    /* corrupt storage: defaults */
  }
  return b;
}

/** The live bindings (mutated by the Controls screen, then saved). */
export const bindings: Bindings = loadBindings();

export function saveBindings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    /* storage unavailable */
  }
}

export function resetBindings(): void {
  Object.assign(bindings, structuredClone(DEFAULT_BINDINGS));
  saveBindings();
}

/**
 * Bind a key to an action's slot. A key can only do one thing, so it's taken off any other
 * action that had it. Returns the action it was taken from, if any.
 */
export function bindKey(b: Bindings, action: Action, slot: 0 | 1, code: string): Action | null {
  let from: Action | null = null;
  for (const a of ACTIONS) {
    for (const k of [0, 1] as const) {
      if (b[a.id].keys[k] === code && !(a.id === action && k === slot)) {
        b[a.id].keys[k] = '';
        if (a.id !== action) from = a.id;
      }
    }
  }
  b[action].keys[slot] = code;
  return from;
}

/** Bind a gamepad button to an action (taken off any other action that had it). */
export function bindPad(b: Bindings, action: Action, button: number): Action | null {
  let from: Action | null = null;
  for (const a of ACTIONS) {
    if (a.id !== action && b[a.id].pad === button) {
      b[a.id].pad = -1;
      from = a.id;
    }
  }
  b[action].pad = button;
  return from;
}

/** Short, readable name for a key code. */
export function keyName(code: string): string {
  if (!code) return '';
  const special: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'SPACE',
    Escape: 'ESC',
    Enter: 'ENTER',
    Tab: 'TAB',
    Backspace: 'BKSP',
    ShiftLeft: 'L-SHIFT',
    ShiftRight: 'R-SHIFT',
    ControlLeft: 'L-CTRL',
    ControlRight: 'R-CTRL',
    AltLeft: 'L-ALT',
    AltRight: 'R-ALT',
    MetaLeft: 'L-CMD',
    MetaRight: 'R-CMD',
    CapsLock: 'CAPS',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
  };
  if (special[code]) return special[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6).toUpperCase();
  return code.toUpperCase();
}

/** Name for a standard-mapping gamepad button (Xbox names, PlayStation in brackets where different). */
export function padName(i: number): string {
  const names = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'SELECT', 'START', 'L-STICK', 'R-STICK', 'D-UP', 'D-DOWN', 'D-LEFT', 'D-RIGHT', 'HOME'];
  return i < 0 ? '' : (names[i] ?? `BUTTON ${i}`);
}

/** Which kind of controller the player last used (hints show that one's buttons). */
export const lastDevice: { kind: 'keys' | 'pad' } = { kind: 'keys' };

/** How to name an action's control in on-screen hints, e.g. "↑" or "RT" (or "↑ / W" with both=true). */
export function controlLabel(action: Action, both = false): string {
  const b = bindings[action];
  if (lastDevice.kind === 'pad' && b.pad >= 0) return padName(b.pad);
  const keys = b.keys.filter(Boolean).map(keyName);
  if (!keys.length) return b.pad >= 0 ? padName(b.pad) : '?';
  return both ? keys.join(' / ') : keys[0];
}
