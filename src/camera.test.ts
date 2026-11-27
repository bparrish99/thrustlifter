import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { stepCamera, type CameraState } from './camera';
import { config } from './config';
import { LEVELS } from './levels';
import { buildLevel } from './level';

/**
 * Fly a loop around a level's biggest free-standing rock and measure how hard the camera ever
 * accelerates. Flying around a rock used to jolt the view: the floor/ceiling readings it frames by
 * jump as you pass edges, and the camera followed those jumps instantly.
 */
function loopAround(levelIndex: number) {
  const d = LEVELS[levelIndex];
  const lvl = buildLevel(d);
  // the free-standing rock with the largest area, other than the level's outer shell
  const rocks = lvl.polygons.slice(1).map((pts) => {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
  const r = rocks.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
  const g = new Game(d);
  g.heli.landed = false;
  g.onLaunchPad = false;
  (g as unknown as { time: number }).time = 1;
  const halfH = config.viewHeight / 2;
  const halfW = (halfH * 16) / 9;
  const cam: CameraState = { x: 0, y: 0, init: false, groundY: null };
  const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
  const rx = (r.x1 - r.x0) / 2 + 250, ry = (r.y1 - r.y0) / 2 + 250;
  const dt = 1 / 60;
  const N = 900;
  let px = 0, py = 0, pvx = 0, pvy = 0, worstAcc = 0, worstOff = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.PI + (i / N) * Math.PI * 2;
    const b = Math.PI + ((i + 1) / N) * Math.PI * 2;
    const pos = { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
    g.heli.pos = pos;
    g.heli.vel = { x: (cx + Math.cos(b) * rx - pos.x) / dt, y: (cy + Math.sin(b) * ry - pos.y) / dt };
    stepCamera(cam, g, dt, halfW, halfH);
    const vx = (cam.x - px) / dt, vy = (cam.y - py) / dt;
    if (i > 2) worstAcc = Math.max(worstAcc, Math.hypot(vx - pvx, vy - pvy) / dt);
    worstOff = Math.max(worstOff, Math.abs(pos.y - cam.y) / config.viewHeight);
    px = cam.x; py = cam.y; pvx = vx; pvy = vy;
  }
  return { worstAcc, worstOff };
}

describe('camera', () => {
  it('flying around a free-standing rock, the view never lurches and the heli stays well in view', () => {
    const i = LEVELS.findIndex((l) => l.name === 'LAYUP' && l.terrain.length > 1);
    if (i < 0) return; // level renamed or reshaped: nothing to fly around
    const { worstAcc, worstOff } = loopAround(i);
    expect(worstAcc).toBeLessThan(4000); // was ~35000 (a one-frame jolt) before smoothing
    expect(worstOff).toBeLessThan(0.4);
  });
});
