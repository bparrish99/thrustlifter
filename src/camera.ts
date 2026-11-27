import { config } from './config';
import type { Game } from './game';
import { clamp, lerp } from './math';

/**
 * The follow camera: where the view centres each frame while flying. Kept apart from drawing so it
 * can be simulated in tests (e.g. flying around a rock and measuring how much the view jolts).
 */
export interface CameraState {
  x: number;
  y: number;
  init: boolean;
  /** Eased height of the ground under the heli, or null if there's none in reach. */
  groundY: number | null;
  /** Eased height of the ceiling above the heli (in view range), or null. */
  ceilY?: number | null;
  /** Where the camera is heading, itself smoothed (so a sudden change of target never jerks the view). */
  aimX?: number;
  aimY?: number;
}

/** How quickly the aim point catches up with the target (per second); higher = snappier. */
const AIM_RATE = 9;

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export function stepCamera(cam: CameraState, game: Game, dt: number, halfW: number, halfH: number): void {
  const h = game.heli;
  let tx = h.pos.x + h.vel.x * config.camLookahead;
  const vh = config.viewHeight;
  const base = h.pos.y + h.vel.y * config.camLookahead;

  // Ground under you: the HIGHEST of several probes across a strip, so crossing a gap
  // (shaft mouth) or a cliff edge doesn't make the reading plunge; then eased over time.
  let gy: number | null = null;
  for (const dx of [-110, -55, 0, 55, 110]) {
    const g = game.groundBelow({ x: h.pos.x + dx, y: h.pos.y });
    if (g !== null && g > h.pos.y + 10 && (gy === null || g < gy)) gy = g;
  }
  if (gy !== null) gy = Math.min(gy, h.pos.y + vh * 0.7); // don't chase floors far below
  if (gy !== null) {
    cam.groundY = cam.groundY === null ? gy : cam.groundY + (gy - cam.groundY) * (1 - Math.exp(-2.5 * dt));
  } else {
    cam.groundY = null;
  }
  // Ceiling: eased the same way. Flying around a rock, the ceiling straight above can jump from
  // the rock's underside to a roof far above (or to nothing) in one frame; easing it, and blending
  // smoothly between "frame the ground" and "centre in the tunnel", keeps the view from jolting.
  const rawCeil = game.ceilingAbove(h.pos, vh);
  if (rawCeil !== null) {
    cam.ceilY = cam.ceilY == null ? rawCeil : cam.ceilY + (rawCeil - cam.ceilY) * (1 - Math.exp(-2.5 * dt));
  } else if (cam.ceilY != null) {
    // no ceiling in reach: let the eased one drift up out of range rather than vanish
    cam.ceilY += (h.pos.y - vh * 1.2 - cam.ceilY) * (1 - Math.exp(-2.5 * dt));
    if (cam.ceilY < h.pos.y - vh * 1.1) cam.ceilY = null;
  }
  const ceil = cam.ceilY ?? null;

  // Frame: put the ground at camGround down the screen. In an enclosed space (floor and ceiling
  // both in view), centre between them instead, blending gradually as the space opens up.
  let ty = cam.groundY === null ? base + vh * 0.2 : cam.groundY - vh * (config.camGround - 0.5);
  if (ceil !== null && cam.groundY !== null) {
    const enclosed = 1 - smoothstep(vh * 0.75, vh * 0.95, cam.groundY - ceil);
    ty = lerp(ty, (ceil + cam.groundY) / 2, enclosed);
  }
  if (game.orb.attached) {
    tx = lerp(tx, game.orb.pos.x, 0.3);
    ty = lerp(ty, game.orb.pos.y, 0.25);
  }
  // Keep the heli between 22% and 60% from the top (clear of the centre messages), and the faster you climb, the more
  // room you get above you (so shafts don't hide what's coming).
  const climb = clamp(-h.vel.y / 220, 0, 1);
  ty = clamp(ty, base - vh * (0.1 + 0.15 * climb), base + vh * (0.28 - 0.38 * climb));
  // keep the view inside the level by limiting where it heads, not by stopping it dead at the edge
  const W = game.level.data.width;
  tx = halfW * 2 >= W ? W / 2 : clamp(tx, halfW, W - halfW);
  ty = Math.min(ty, game.level.maxY - halfH);
  if (!game.alive) {
    tx = cam.x;
    ty = cam.y;
  }
  if (!cam.init || (game.time < 0.05 && game.phase === 'playing') || cam.aimX === undefined || cam.aimY === undefined) {
    cam.x = tx;
    cam.y = ty;
    cam.aimX = tx;
    cam.aimY = ty;
    cam.init = true;
  }
  // two gentle stages instead of one: the aim point eases toward the target, and the camera eases
  // toward the aim, so the view speeds up and slows down smoothly rather than lurching
  const ka = 1 - Math.exp(-AIM_RATE * dt);
  cam.aimX += (tx - cam.aimX) * ka;
  cam.aimY += (ty - cam.aimY) * ka;
  const k = 1 - Math.exp(-config.camFollow * dt);
  cam.x += (cam.aimX - cam.x) * k;
  cam.y += (cam.aimY - cam.y) * k;
  cam.x = halfW * 2 >= W ? W / 2 : clamp(cam.x, halfW, W - halfW);
  cam.y = Math.min(cam.y, game.level.maxY - halfH);
}
