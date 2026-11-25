import { describe, expect, it } from 'vitest';
import { DEFAULTS } from './config';
import { Game, STEP, type FrameInput } from './game';
import provingGround from './levels/proving-ground.json';
import type { LevelData } from './level';
import { deg, dist } from './math';
import { ANCHOR, createHeli, heliPoint, integrate, noseDir, rotorNormal, solveRod, thrustForce, type Body } from './physics';

const cfg = { ...DEFAULTS };
const idle: FrameInput = { tiltAxis: 0, rotor: 0, dive: 0, fire: false, bomb: false, flip: false, pickup: false, restart: false };

describe('geometry', () => {
  it('tilting right points the rotor up-right and dips the nose when facing right', () => {
    const n = rotorNormal(deg(20));
    expect(n.x).toBeGreaterThan(0);
    expect(n.y).toBeLessThan(0);
    const nose = noseDir(deg(20), 1);
    expect(nose.x).toBeGreaterThan(0);
    expect(nose.y).toBeGreaterThan(0); // y down => firing slightly downward
  });

  it('flipping to face left while tilted right aims the nose up-left', () => {
    const nose = noseDir(deg(20), -1);
    expect(nose.x).toBeLessThan(0);
    expect(nose.y).toBeLessThan(0);
  });
});

describe('rigid rod', () => {
  it('holds its length through a long violent swing', () => {
    const heli = createHeli({ x: 0, y: 0 }, cfg);
    const orb: Body = { pos: { x: 110, y: 19 }, vel: { x: 0, y: 0 }, mass: cfg.orbMass };
    let maxErr = 0;
    for (let i = 0; i < 240 * 10; i++) {
      const push = Math.sin(i / 60) * 900;
      integrate(heli, { x: push, y: -cfg.gravity * 1.6 }, cfg.gravity, 0, STEP);
      integrate(orb, { x: 0, y: 0 }, cfg.gravity, 0, STEP);
      solveRod(heli, heliPoint(heli, ANCHOR), orb, 110);
      maxErr = Math.max(maxErr, Math.abs(dist(heliPoint(heli, ANCHOR), orb.pos) - 110));
    }
    expect(maxErr).toBeLessThan(1e-6);
  });

  it('transfers momentum: a swinging orb tugs the heli sideways', () => {
    const heli = createHeli({ x: 0, y: 0 }, cfg);
    const orb: Body = { pos: { x: 0, y: 129 }, vel: { x: 300, y: 0 }, mass: cfg.orbMass };
    for (let i = 0; i < 60; i++) {
      integrate(heli, { x: 0, y: -cfg.gravity * (cfg.heliMass + cfg.orbMass) }, cfg.gravity, 0, STEP);
      integrate(orb, { x: 0, y: 0 }, cfg.gravity, 0, STEP);
      solveRod(heli, heliPoint(heli, ANCHOR), orb, 110);
    }
    expect(heli.vel.x).toBeGreaterThan(10);
  });
});

describe('game', () => {
  it('starts landed and stays put with the rotor off', () => {
    const g = new Game(provingGround as LevelData);
    const y0 = g.heli.pos.y;
    for (let i = 0; i < 60; i++) g.update(idle, 1 / 60);
    expect(g.heli.landed).toBe(true);
    expect(g.heli.pos.y).toBe(y0);
    expect(g.phase).toBe('playing');
  });

  it('lifts off with the rotor held, then falls back when released', () => {
    const g = new Game(provingGround as LevelData);
    const y0 = g.heli.pos.y;
    for (let i = 0; i < 60; i++) g.update({ ...idle, rotor: 1 }, 1 / 60);
    expect(g.heli.landed).toBe(false);
    expect(g.heli.pos.y).toBeLessThan(y0 - 50);
    for (let i = 0; i < 150; i++) g.update(idle, 1 / 60);
    expect(g.heli.vel.y).toBeGreaterThan(0);
  });

  it('can lift the orb at full thrust when level', () => {
    const total = (cfg.heliMass + cfg.orbMass) * cfg.gravity;
    expect(cfg.maxThrust).toBeGreaterThan(total);
  });

  it('tethers the orb when pulling away to rod length, and bombs are then blocked', () => {
    const g = new Game(provingGround as LevelData);
    const orb = g.orb;
    g.heli.landed = false;
    g.heli.pos = { x: orb.pos.x, y: orb.pos.y - 19 - 80 };
    g.heli.vel = { x: 0, y: -60 };
    g.heli.throttle = 1;
    for (let i = 0; i < 40 && !orb.attached; i++) g.update({ ...idle, rotor: 1, pickup: true }, 1 / 60);
    expect(orb.attached).toBe(true);
    expect(g.phase).toBe('playing');
    const before = g.projectiles.length;
    g.update({ ...idle, rotor: 1, bomb: true }, 1 / 60);
    expect(g.projectiles.length).toBe(before);
    expect(g.bombBlockedFlash).toBeGreaterThan(0);
  });

  it('crashes when flown into the ground', () => {
    const g = new Game(provingGround as LevelData);
    g.heli.landed = false;
    g.heli.pos = { x: 700, y: 600 };
    g.heli.vel = { x: 0, y: 400 };
    for (let i = 0; i < 120 && g.phase === 'playing'; i++) g.update(idle, 1 / 60);
    expect(g.phase).toBe('dead');
  });
});

describe('max horizontal speed', () => {
  it('the rotor cannot push the heli sideways past maxHorizSpeed', () => {
    const heli = createHeli({ x: 0, y: 0 }, cfg);
    heli.tilt = deg(cfg.maxTiltDeg);
    heli.throttle = 1;
    for (let i = 0; i < 240 * 20; i++) {
      const f = thrustForce(heli, cfg);
      integrate(heli, { x: f.x, y: -cfg.gravity * heli.mass }, cfg.gravity, cfg.heliDrag, STEP); // hold altitude
    }
    expect(heli.vel.x).toBeLessThanOrEqual(cfg.maxHorizSpeed + 0.01);
    expect(heli.vel.x).toBeGreaterThan(cfg.maxHorizSpeed * 0.8);
  });
});

describe('weapons', () => {
  const flying = () => {
    const g = new Game(provingGround as LevelData);
    g.heli.landed = false;
    g.heli.pos = { x: 1300, y: 300 };
    g.heli.throttle = 1;
    return g;
  };

  it('missiles leave slow and accelerate to top speed', () => {
    const g = flying();
    g.update({ ...idle, rotor: 1, fire: true }, STEP);
    const m = g.projectiles.find((p) => p.kind === 'missile')!;
    const s0 = m.speed!;
    expect(s0).toBeLessThan(cfg.missileSpeed * 0.5);
    for (let i = 0; i < 30; i++) g.update({ ...idle, rotor: 1 }, 1 / 60);
    expect(m.speed).toBe(cfg.missileSpeed);
  });

  it('bombs drop with a downward and forward kick', () => {
    const g = flying();
    g.heli.facing = -1;
    g.heli.vel = { x: 0, y: 0 };
    g.update({ ...idle, rotor: 1, bomb: true }, STEP);
    const b = g.projectiles.find((p) => p.kind === 'bomb')!;
    expect(b.vel.y).toBeGreaterThan(cfg.bombDropSpeed * 0.9);
    expect(b.vel.x).toBeLessThan(-cfg.bombForwardSpeed * 0.9); // facing left => forward is -x
  });
});

describe('dive', () => {
  it('holding dive accelerates the heli downward faster than gravity alone', () => {
    const run = (dive: number) => {
      const g = new Game(provingGround as LevelData);
      g.heli.landed = false;
      g.heli.pos = { x: 1300, y: 200 };
      for (let i = 0; i < 30; i++) g.update({ ...idle, dive }, 1 / 60);
      return g.heli.vel.y;
    };
    expect(run(1)).toBeGreaterThan(run(0) + cfg.diveAccel * 0.4);
  });
});
