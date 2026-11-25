/**
 * Every tunable that defines how the game *feels*. The in-game tuning panel (T)
 * edits this object live; changes persist in localStorage. When a set of values
 * feels right, use "Copy settings" in the panel and bake them in here.
 *
 * Units: world units (~1 px at default zoom), seconds, y points DOWN.
 */
export const DEFAULTS = {
  // World
  gravity: 165,

  // Helicopter body
  heliMass: 1,
  heliDrag: 0.11, // linear air drag, 1/s

  // Rotor: thrust acts along the rotor normal, scaled by throttle (0..1), instantly
  maxThrust: 450, // force at full throttle (heli-only thrust/weight = maxThrust / (heliMass*gravity))
  diveAccel: 115, // extra straight-down acceleration while holding dive (↓); arcade, not realistic
  maxHorizSpeed: 250, // rotor can't push you sideways faster than this (momentum from the orb/dives can briefly exceed it)

  // Tilt: input moves a target angle; actual tilt eases toward it. No auto-level.
  maxTiltDeg: 45,
  tiltRateDeg: 85, // how fast the target angle moves while a tilt key is held
  tiltEase: 8, // how quickly actual tilt catches up to the target (higher = snappier)

  // Orb + rigid rod
  orbMass: 0.95,
  orbRadius: 16,
  orbDrag: 0.04,
  rodLength: 110,

  // Landing (skids on a pad only)
  landMaxSpeed: 45,
  landMaxTiltDeg: 10,

  // Weapons
  missileLaunchSpeed: 120, // leaves the tube slow...
  missileAccel: 2200, // ...then the motor kicks in (speed gained per second)
  missileSpeed: 750, // top speed
  missileCooldown: 0.53,
  missileLife: 1.6,
  bombCooldown: 0.6,
  bombDropSpeed: 115, // initial downward push out of the bay
  bombForwardSpeed: 45, // initial push toward the way you're facing

  // Camera / look
  viewHeight: 900, // world units visible vertically
  camLookahead: 0.35, // seconds of velocity lead
  camFollow: 4,
  glow: 1,
};

export type Config = typeof DEFAULTS;

const STORAGE_KEY = 'thrustlifter.config.v2'; // bump when defaults change meaningfully

function load(): Config {
  const cfg: Config = { ...DEFAULTS };
  try {
    if (typeof localStorage === 'undefined') return cfg;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cfg;
    const saved = JSON.parse(raw) as Partial<Config>;
    for (const k of Object.keys(DEFAULTS) as (keyof Config)[]) {
      if (typeof saved[k] === 'number' && Number.isFinite(saved[k])) cfg[k] = saved[k] as number;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return cfg;
}

/** The live, shared config object. Mutated in place by the tuning panel. */
export const config: Config = load();

export function saveConfig(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* storage unavailable */
  }
}

export function resetConfig(): void {
  Object.assign(config, DEFAULTS);
  saveConfig();
}
