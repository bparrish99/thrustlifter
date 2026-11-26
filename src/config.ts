/**
 * Every tunable that defines how the game *feels*. The in-game tuning panel (T)
 * edits this object live; changes persist in localStorage. When a set of values
 * feels right, use "Copy settings" in the panel and bake them in here.
 *
 * Units: world units (~1 px at default zoom), seconds, y points DOWN.
 */
export const DEFAULTS = {
  // World
  gravity: 230,

  // Helicopter body
  heliMass: 1,
  heliDrag: 0.11, // linear air drag, 1/s

  // Rotor: thrust acts along the rotor normal, scaled by throttle (0..1), instantly
  maxThrust: 645, // force at full throttle (heli-only thrust/weight = maxThrust / (heliMass*gravity))
  diveAccel: 170, // extra straight-down acceleration while holding dive (↓); arcade, not realistic
  maxHorizSpeed: 335, // rotor can't push you sideways faster than this (momentum from the orb/dives can briefly exceed it)

  // Tilt: input moves a target angle; actual tilt eases toward it. No auto-level.
  maxTiltDeg: 50,
  tiltRateDeg: 101, // how fast the target angle moves while a tilt key is held
  tiltEase: 8, // how quickly actual tilt catches up to the target (higher = snappier)

  // Orb + rigid rod
  orbMass: 1.05,
  orbRadius: 16,
  orbDrag: 0.04,
  rodLength: 110,
  orbMaxImpact: 240, // orb shatters if it hits anything head-on faster than this (glancing hits count less)
  orbBounce: 0.45, // how bouncy a released orb is (0 = dead, 1 = superball)

  // Landing (skids on a pad only)
  landMaxSpeed: 95,
  landMaxTiltDeg: 10,

  // Weapons
  missileLaunchSpeed: 115, // leaves the tube slow...
  missileAccel: 2100, // ...then the motor kicks in (speed gained per second)
  missileSpeed: 750, // top speed
  missileCooldown: 0.26,
  missileLife: 1.6,

  // Enemies: turrets
  turretRange: 650,
  turretInterval: 2.2, // seconds between shots (±20%)
  turretCharge: 0.55, // telegraph glow before each shot
  turretShotSpeed: 300,
  turretLead: 0.5, // 0 = aims where you are, 1 = aims where you'll be
  turretArcDeg: 80, // how far from straight-out they can aim

  // Camera / look
  viewHeight: 890, // world units visible vertically
  camLookahead: 0.35, // seconds of velocity lead
  camFollow: 4,
  camGround: 0.78, // where the ground below you is framed on screen (0.5 = middle, 0.9 = near the bottom); heli stays between 22% and 60% from the top
  glow: 1,
  volume: 0.5,
  sfxVolume: 0.45, // effects level relative to the rotor (multiplies volume)
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
