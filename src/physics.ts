import type { Config } from './config';
import { approach, clamp, deg, dot, type Vec } from './math';

/*
 * Conventions: y points down. tilt > 0 means the rotor is tilted to the RIGHT
 * (clockwise on screen). The rotor normal is (sin t, -cos t). The body's nose
 * points along facing * (cos t, sin t): tilted right + facing right = nose dips
 * (missile fires slightly down); flip to face left = nose up (fires up-left).
 */

export interface Body {
  pos: Vec;
  vel: Vec;
  mass: number;
}

export interface HeliState extends Body {
  tilt: number;
  tiltTarget: number;
  throttle: number; // 0..1, applied instantly (no spool lag)
  facing: 1 | -1;
  landed: boolean;
}

export interface HeliControls {
  tiltAxis: number; // -1..1
  rotor: number; // throttle 0..1 (keyboard: 0 or 1; gamepad trigger: analog)
}

// ---- Helicopter geometry (local space, facing right, origin = body centre) ----
// Collision shapes only. Purely decorative detail lives in render.ts.
const P = (x: number, y: number): Vec => ({ x, y });
export const BODY: Vec[] = [
  P(-12, -8), P(-2, -10), P(9, -9), P(16, -5), P(20, 0), P(21, 4),
  P(17, 8), P(6, 10), P(-9, 9), P(-15, 4), P(-15, -2),
];
export const TAIL_BOOM: [Vec, Vec] = [P(-15, 0), P(-44, -3)];
export const TAIL_FIN: [Vec, Vec] = [P(-40, -3), P(-48, -13)];
export const MAST: [Vec, Vec] = [P(0, -10), P(0, -14)];
export const ROTOR_Y = -14;
export const ROTOR_R = 38;
export const ROTOR: [Vec, Vec] = [P(-ROTOR_R, ROTOR_Y), P(ROTOR_R, ROTOR_Y)];
export const STRUTS: [Vec, Vec][] = [
  [P(-6, 9), P(-8, 15)],
  [P(7, 10), P(8, 15)],
];
export const SKID_Y = 15;
export const SKID: [Vec, Vec] = [P(-14, SKID_Y), P(14, SKID_Y)];
export const SKID_TOE: [Vec, Vec] = [P(14, SKID_Y), P(18, SKID_Y - 3)];
export const ANCHOR = P(0, 16); // rod hook, just under the skids
export const NOSE = P(22, 3);
export const BOMB_BAY = P(0, 17);
export const TAIL_ROTOR_HUB = P(-47, -5);
export const TAIL_ROTOR_R = 6.5;

export interface HullSegment {
  a: Vec;
  b: Vec;
  gear: boolean; // skids/struts: the only parts allowed to touch a pad
  rotor: boolean;
}

const HULL_LOCAL: HullSegment[] = [
  ...BODY.map((p, i) => ({ a: p, b: BODY[(i + 1) % BODY.length], gear: false, rotor: false })),
  { a: TAIL_BOOM[0], b: TAIL_BOOM[1], gear: false, rotor: false },
  { a: TAIL_FIN[0], b: TAIL_FIN[1], gear: false, rotor: false },
  { a: MAST[0], b: MAST[1], gear: false, rotor: false },
  { a: ROTOR[0], b: ROTOR[1], gear: false, rotor: true },
  ...STRUTS.map(([a, b]) => ({ a, b, gear: true, rotor: false })),
  { a: SKID[0], b: SKID[1], gear: true, rotor: false },
  { a: SKID_TOE[0], b: SKID_TOE[1], gear: true, rotor: false },
];

export const HULL_RADIUS = 54;

/** Transform a local point to world. `facing` may be fractional (flip animation). */
export function toWorld(pos: Vec, tilt: number, facing: number, p: Vec): Vec {
  const x = p.x * facing;
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return { x: pos.x + x * c - p.y * s, y: pos.y + x * s + p.y * c };
}

export function heliPoint(h: HeliState, p: Vec): Vec {
  return toWorld(h.pos, h.tilt, h.facing, p);
}

export function hullWorld(h: HeliState): HullSegment[] {
  return HULL_LOCAL.map((s) => ({ ...s, a: heliPoint(h, s.a), b: heliPoint(h, s.b) }));
}

export function rotorNormal(tilt: number): Vec {
  return { x: Math.sin(tilt), y: -Math.cos(tilt) };
}

export function noseDir(tilt: number, facing: number): Vec {
  return { x: facing * Math.cos(tilt), y: facing * Math.sin(tilt) };
}

export function createHeli(pos: Vec, cfg: Config): HeliState {
  return { pos: { ...pos }, vel: { x: 0, y: 0 }, mass: cfg.heliMass, tilt: 0, tiltTarget: 0, throttle: 0, facing: 1, landed: false };
}

/** Tilt + throttle. Tilt input moves the target; actual tilt eases toward it. Throttle is instant. */
export function updateControls(h: HeliState, input: HeliControls, cfg: Config, dt: number): void {
  const maxTilt = deg(cfg.maxTiltDeg);
  if (h.landed) {
    h.tiltTarget = 0;
    h.tilt = 0;
  } else {
    h.tiltTarget = clamp(h.tiltTarget + input.tiltAxis * deg(cfg.tiltRateDeg) * dt, -maxTilt, maxTilt);
    h.tilt = approach(h.tilt, h.tiltTarget, cfg.tiltEase, dt);
  }
  h.throttle = clamp(input.rotor, 0, 1);
}

/**
 * Rotor thrust. The horizontal part fades out as you approach maxHorizSpeed in the
 * direction you're pushing, so the rotor alone can't take you past it. This is not a
 * hard clamp: a swinging orb or a dive can briefly carry you faster, and drag
 * bleeds that off. That keeps the rod physics honest.
 */
export function thrustForce(h: HeliState, cfg: Config): Vec {
  const n = rotorNormal(h.tilt);
  const f = h.throttle * cfg.maxThrust;
  let fx = n.x * f;
  if (fx !== 0 && Math.sign(fx) === Math.sign(h.vel.x)) {
    const ramp = cfg.maxHorizSpeed * 0.15; // soften the last 15% so it doesn't feel like a wall
    fx *= clamp((cfg.maxHorizSpeed - Math.abs(h.vel.x)) / ramp, 0, 1);
  }
  return { x: fx, y: n.y * f };
}

/** Semi-implicit Euler with gravity and linear drag. */
export function integrate(b: Body, force: Vec, gravity: number, drag: number, dt: number): void {
  b.vel.x += (force.x / b.mass) * dt;
  b.vel.y += (force.y / b.mass + gravity) * dt;
  const damp = Math.exp(-drag * dt);
  b.vel.x *= damp;
  b.vel.y *= damp;
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
}

/**
 * Rigid massless rod between the heli's anchor and the orb. Projects positions
 * back to exact length (mass-weighted) and removes relative velocity along the
 * rod (a perfectly inelastic constraint), so the orb both drags and shoves the heli.
 * Pass heliFixed=true while landed (heli acts as infinite mass).
 */
export function solveRod(heli: Body, anchor: Vec, orb: Body, length: number, heliFixed = false): void {
  const dx = orb.pos.x - anchor.x;
  const dy = orb.pos.y - anchor.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  const n = { x: dx / d, y: dy / d };
  const wH = heliFixed ? 0 : 1 / heli.mass;
  const wO = 1 / orb.mass;
  const wSum = wH + wO;

  const err = d - length;
  heli.pos.x += n.x * err * (wH / wSum);
  heli.pos.y += n.y * err * (wH / wSum);
  orb.pos.x -= n.x * err * (wO / wSum);
  orb.pos.y -= n.y * err * (wO / wSum);

  const vrel = dot({ x: orb.vel.x - heli.vel.x, y: orb.vel.y - heli.vel.y }, n);
  const j = vrel / wSum;
  heli.vel.x += n.x * j * wH;
  heli.vel.y += n.y * j * wH;
  orb.vel.x -= n.x * j * wO;
  orb.vel.y -= n.y * j * wO;
}
