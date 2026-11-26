import { describe, expect, it } from 'vitest';
import { DEFAULTS } from './config';
import { Game, STEP, type FrameInput } from './game';
import provingGround from './levels/proving-ground.json';
import type { LevelData } from './level';
import { deg, dist, distPointSegment, segmentsIntersect } from './math';
import { LEVELS } from './levels';
import { buildLevel, segmentsNear, type Level } from './level';
import { ANCHOR, createHeli, heliPoint, integrate, noseDir, rotorNormal, solveRod, thrustForce, type Body } from './physics';

const cfg = { ...DEFAULTS };
const idle: FrameInput = { tiltAxis: 0, rotor: 0, dive: 0, fire: false, flip: false, pickup: false, pickupPressed: false, restart: false };

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

  it('tethers the orb when pulling away to rod length', () => {
    const g = new Game(provingGround as LevelData);
    const orb = g.orb;
    g.heli.landed = false;
    g.heli.pos = { x: orb.pos.x, y: orb.pos.y - 19 - 80 };
    g.heli.vel = { x: 0, y: -60 };
    g.heli.throttle = 1;
    for (let i = 0; i < 40 && !orb.attached; i++) g.update({ ...idle, rotor: 1, pickup: true }, 1 / 60);
    expect(orb.attached).toBe(true);
    expect(g.phase).toBe('playing');
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

describe('orb bowl, release and return to base', () => {
  const hoverSolo = () => (cfg.heliMass * cfg.gravity) / cfg.maxThrust;

  /** Heli parked high in the sky (hovering), orb free at `orbPos` moving at `vel`. */
  const dropScene = (orbPos: { x: number; y: number }, vel = { x: 0, y: 0 }) => {
    const g = new Game(provingGround as LevelData);
    g.heli.landed = false;
    g.heli.pos = { x: g.level.bowl.cx, y: -600 };
    g.orb.free = true;
    g.orb.pos = { ...orbPos };
    g.orb.vel = { ...vel };
    return g;
  };
  const run = (g: Game, seconds: number, extra: Partial<FrameInput> = {}) => {
    for (let i = 0; i < seconds * 60; i++) g.update({ ...idle, rotor: hoverSolo(), ...extra }, 1 / 60);
  };

  it('tapping Space while carrying releases the orb, keeping its momentum', () => {
    const g = new Game(provingGround as LevelData);
    g.heli.landed = false;
    g.heli.pos = { x: 1300, y: 200 };
    g.orb.attached = true;
    g.orb.pos = { x: 1300, y: 200 + 16 + cfg.rodLength };
    g.orb.vel = { x: 120, y: 0 };
    g.heli.vel = { x: 120, y: 0 };
    g.update({ ...idle, pickup: true, pickupPressed: true }, 1 / 60);
    expect(g.orb.attached).toBe(false);
    expect(g.orb.free).toBe(true);
    expect(g.orb.vel.x).toBeGreaterThan(100);
    // still holding Space right after release must not grab it straight back
    run(g, 0.3, { pickup: true });
    expect(g.orb.attached).toBe(false);
  });

  it('a gentle drop into the bowl settles and counts as delivered (level not over yet)', () => {
    const b = new Game(provingGround as LevelData).level.bowl;
    const g = dropScene({ x: b.cx + 4, y: b.rimY - 80 });
    run(g, 3);
    expect(g.orb.delivered).toBe(true);
    expect(g.phase).toBe('playing');
  });

  it('a layup: lobbed in sideways, it bounces around and still settles in the cup', () => {
    const b = new Game(provingGround as LevelData).level.bowl;
    const g = dropScene({ x: b.cx - 70, y: b.rimY - 70 }, { x: 70, y: -40 });
    run(g, 4);
    expect(g.orb.delivered).toBe(true);
  });

  it('a drop from too high shatters the orb, but the pilot lives and a new orb appears', () => {
    const b = new Game(provingGround as LevelData).level.bowl;
    const height = (cfg.orbMaxImpact * 1.5) ** 2 / (2 * cfg.gravity);
    const g = dropScene({ x: b.cx, y: b.rimY - height });
    run(g, 2.5);
    expect(g.lastOrbLoss).toMatch(/impact/);
    expect(g.orb.delivered).toBe(false);
    expect(g.phase).toBe('playing');
    run(g, 2);
    expect(g.orb.pos).toEqual(g.orb.home);
  });

  it('lowering the orb gently onto the bowl on the rod releases it into the cup', () => {
    const g = new Game(provingGround as LevelData);
    const b = g.level.bowl;
    const orbPos = { x: b.cx, y: b.rest.y - 6 };
    g.heli.landed = false;
    g.heli.pos = { x: orbPos.x, y: orbPos.y - cfg.rodLength - 16 };
    g.heli.vel = { x: 0, y: 30 };
    g.orb.attached = true;
    g.orb.pos = orbPos;
    g.orb.vel = { x: 0, y: 30 };
    run(g, 0.6, { rotor: ((cfg.heliMass + cfg.orbMass) * cfg.gravity) / cfg.maxThrust });
    expect(g.orb.attached).toBe(false);
    run(g, 1.5, { rotor: 1 }); // climb away
    expect(g.orb.delivered).toBe(true);
  });

  it('slamming the carried orb into the bowl destroys the orb but the pilot lives', () => {
    const g = new Game(provingGround as LevelData);
    const b = g.level.bowl;
    const orbPos = { x: b.cx, y: b.rest.y - 4 };
    const v = cfg.orbMaxImpact * 1.6;
    g.heli.landed = false;
    g.heli.pos = { x: orbPos.x, y: orbPos.y - cfg.rodLength - 16 };
    g.heli.vel = { x: 0, y: v };
    g.orb.attached = true;
    g.orb.pos = orbPos;
    g.orb.vel = { x: 0, y: v };
    run(g, 0.1);
    expect(g.phase).toBe('playing');
    expect(g.lastOrbLoss).toMatch(/impact/);
    expect(g.orb.attached).toBe(false);
  });

  it('a carried orb dragged into the ground is destroyed and respawns; the pilot lives', () => {
    const g = new Game(provingGround as LevelData);
    g.heli.landed = false;
    g.heli.pos = { x: 3000, y: 860 - 16 - cfg.rodLength - 30 }; // flat ground at y=860 around x=3000..3200
    g.orb.attached = true;
    g.orb.pos = { x: 3000, y: g.heli.pos.y + 16 + cfg.rodLength };
    run(g, 1, { rotor: 0 }); // fall
    expect(g.phase).toBe('playing');
    expect(g.lastOrbLoss).toMatch(/ground/);
    run(g, 2.5, { rotor: 1 });
    expect(g.orb.pos).toEqual(g.orb.home);
  });

  it('a dropped orb that lands on plain ground explodes, however gently', () => {
    const g = dropScene({ x: 3100, y: 860 - 16 - 5 });
    run(g, 1);
    expect(g.lastOrbLoss).toMatch(/ground/);
  });

  it('shooting the orb destroys it', () => {
    const g = dropScene({ x: 1300, y: 300 });
    g.orb.free = false; // hanging still in the air for the test
    g.heli.pos = { x: 1200, y: 300 };
    g.heli.tilt = g.heli.tiltTarget = 0;
    g.heli.facing = 1;
    run(g, 0.6, { fire: true });
    expect(g.lastOrbLoss).toMatch(/shot/);
  });

  it('the mission completes only when you land back on your pad after delivering', () => {
    const g = new Game(provingGround as LevelData);
    const pad = g.level.startPad;
    const hop = () => {
      g.heli.landed = false;
      g.heli.pos = { x: pad.x + pad.w / 2, y: pad.y - 60 };
      g.heli.vel = { x: 0, y: 30 };
      g.heli.tilt = g.heli.tiltTarget = 0;
      run(g, 1.5, { rotor: 0.3 });
    };
    hop();
    expect(g.heli.landed).toBe(true);
    expect(g.phase).toBe('playing');
    g.orb.delivered = true;
    hop();
    expect(g.phase).toBe('complete');
    expect(g.completedAt).not.toBeNull();
  });
});

describe('turrets', () => {
  // Proving Ground turret 0 sits on a hilltop at (940, 610), facing up.
  const scene = (heliPos: { x: number; y: number }) => {
    const g = new Game(provingGround as LevelData);
    g.heli.landed = false;
    g.heli.pos = { ...heliPos };
    g.turrets.forEach((t, i) => (t.alive = i === 0));
    g.turrets[0].cooldown = 0.8;
    return g;
  };
  const hover = (g: Game, seconds: number) => {
    for (let i = 0; i < seconds * 60 && g.phase === 'playing'; i++) {
      g.heli.pos = { ...g.heli.pos }; // keep it parked
      g.heli.vel = { x: 0, y: 0 };
      g.update({ ...idle, rotor: (cfg.heliMass * cfg.gravity) / cfg.maxThrust }, 1 / 60);
    }
  };

  it('telegraphs with a charge, then fires and shoots down a heli in range and sight', () => {
    const g = scene({ x: 1000, y: 300 });
    let sawCharge = false;
    for (let i = 0; i < 6 * 60 && g.phase === 'playing'; i++) {
      g.heli.vel = { x: 0, y: 0 };
      g.update({ ...idle, rotor: (cfg.heliMass * cfg.gravity) / cfg.maxThrust }, 1 / 60);
      if (g.turrets[0].charge > 0.3) sawCharge = true;
    }
    expect(sawCharge).toBe(true);
    expect(g.phase).toBe('dead');
    expect(g.lastCrash).toBe('SHOT DOWN');
  });

  it('holds fire without line of sight', () => {
    // tiny custom level: flat ground at y=800, turret at x=300, a tall wall at x=500..540
    const level: LevelData = {
      name: 'LOS TEST',
      width: 1200,
      terrain: [
        [0, 1000, 0, 800, 500, 800, 500, 200, 540, 200, 540, 800, 1200, 800, 1200, 1000],
      ],
      pads: [{ x: 20, y: 790, w: 100, kind: 'start' }],
      orb: { x: 1000, y: 783.5 },
      bowl: { x: 1100, y: 800 },
      turrets: [{ x: 300, y: 800 }],
    };
    const g = new Game(level);
    g.heli.landed = false;
    g.heli.pos = { x: 700, y: 500 }; // in range, inside the arc, but behind the wall
    g.turrets[0].cooldown = 0.5;
    for (let i = 0; i < 5 * 60 && g.phase === 'playing'; i++) {
      g.heli.vel = { x: 0, y: 0 };
      g.update({ ...idle, rotor: (cfg.heliMass * cfg.gravity) / cfg.maxThrust }, 1 / 60);
    }
    expect(g.phase).toBe('playing');
    expect(g.turrets[0].tracking).toBe(false);
    expect(g.projectiles.filter((p) => p.kind === 'enemy').length).toBe(0);
  });

  it('holds fire when out of range', () => {
    const g = scene({ x: 940 + cfg.turretRange + 200, y: 200 });
    hover(g, 5);
    expect(g.projectiles.filter((p) => p.kind === 'enemy').length).toBe(0);
  });

  it('enemy shots destroy the orb but do not hurt other turrets', () => {
    const g = scene({ x: 1000, y: -400 });
    g.turrets[1].alive = true;
    g.orb.pos = { x: 940, y: 450 };
    g.projectiles.push({ kind: 'enemy', pos: { x: 940, y: 520 }, vel: { x: 0, y: -300 }, life: 2 });
    hover(g, 0.5);
    expect(g.lastOrbLoss).toMatch(/shot/);
    expect(g.turrets[1].alive).toBe(true);
  });
});

describe('Deep Caverns is flyable', () => {
  // Minimum distance from point p to any solid edge (respecting current gate states).
  const clearance = (level: Level, p: { x: number; y: number }) => {
    const r = 200;
    let best = Infinity;
    for (const s of segmentsNear(level, p.x - r, p.y - r, p.x + r, p.y + r)) best = Math.min(best, distPointSegment(p, s.a, s.b));
    return best;
  };
  // Walk a route of waypoints in 8-unit steps and report the tightest squeeze.
  const tightest = (level: Level, route: [number, number][], below = 0) => {
    let min = Infinity;
    let where = route[0];
    for (let i = 0; i + 1 < route.length; i++) {
      const [ax, ay] = route[i];
      const [bx, by] = route[i + 1];
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 8);
      for (let k = 0; k <= n; k++) {
        const p = { x: ax + ((bx - ax) * k) / n, y: ay + ((by - ay) * k) / n + below };
        const c = clearance(level, p);
        if (c < min) {
          min = c;
          where = [Math.round(p.x), Math.round(p.y)];
        }
      }
    }
    return { min, where };
  };
  const level = buildLevel(LEVELS[1]);
  const [sealGate, exitGate] = level.gates;
  const HELI = 45; // heli needs this much room around its centre (rotor half-span is 38)
  const ORB_DROP = 16 + 110; // orb centre hangs this far below the heli
  const ORB = 20; // orb radius 16 + a little

  const lineOfSight = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    !segmentsNear(level, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)).some((sg) => segmentsIntersect(a, b, sg.a, sg.b));
  const OUTBOUND: [number, number][] = [[280, 520], [280, 420], [860, 420], [860, 1150], [1050, 1250]];
  const CARRY: [number, number][] = [[1050, 1272], [1300, 1260], [1450, 1290], [1550, 1260], [1650, 1240], [1800, 1260], [2025, 1260], [2025, 1800], [2300, 1800], [2500, 1830], [2650, 1800], [2800, 1765], [2950, 1790], [3125, 1800], [3125, 1525], [3500, 1525], [3700, 1530], [3780, 1700], [3800, 1900], [3820, 2050]];
  const RETURN: [number, number][] = [[3820, 1900], [4090, 1700], [4090, 700], [4090, 420], [280, 420], [280, 520]];

  it('outbound (heli only): pad, down the first shaft, straight to the orb', () => {
    sealGate.open = true;
    exitGate.open = false;
    const r = tightest(level, OUTBOUND);
    expect(r.min, `tightest at ${r.where}`).toBeGreaterThan(HELI);
  });

  it('carrying the orb: the long cavern route to the bowl', () => {
    sealGate.open = false;
    exitGate.open = false;
    const heli = tightest(level, CARRY);
    const orb = tightest(level, [[1050, 1240], ...CARRY.slice(1, -1)], ORB_DROP); // start just after lift-off from the pedestal
    expect(heli.min, `heli tightest at ${heli.where}`).toBeGreaterThan(HELI);
    expect(orb.min, `orb tightest at ${orb.where}`).toBeGreaterThan(ORB);
  });

  it('no turret can see any part of the carry route (enemies only on the way in and home)', () => {
    sealGate.open = false;
    exitGate.open = false;
    for (const t of LEVELS[1].turrets) {
      const a = deg(t.dir ?? -90);
      const eye = { x: t.x + Math.cos(a) * 8, y: t.y + Math.sin(a) * 8 };
      for (let i = 0; i + 1 < CARRY.length; i++) {
        for (let k = 0; k <= 10; k++) {
          const [ax, ay] = CARRY[i];
          const [bx, by] = CARRY[i + 1];
          const p = { x: ax + ((bx - ax) * k) / 10, y: ay + ((by - ay) * k) / 10 };
          for (const q of [p, { x: p.x, y: p.y + ORB_DROP }]) {
            const seen = dist(eye, q) < cfg.turretRange && lineOfSight(eye, q);
            expect(seen, `turret at ${t.x},${t.y} sees ${Math.round(q.x)},${Math.round(q.y)}`).toBe(false);
          }
        }
      }
    }
  });

  it('return: up the exit shaft once its gate opens, then home over the surface', () => {
    exitGate.open = true;
    const r = tightest(level, RETURN);
    expect(r.min, `tightest at ${r.where}`).toBeGreaterThan(HELI);
  });

  it('the exit shaft is blocked until delivery, and the way in seals on pickup', () => {
    exitGate.open = false;
    sealGate.open = false;
    expect(tightest(level, [[4090, 1330], [4090, 1460]]).min).toBeLessThan(5);
    expect(tightest(level, [[860, 950], [860, 1080]]).min).toBeLessThan(5);
  });

  it('every turret sits on a surface', () => {
    for (const t of LEVELS[1].turrets) expect(clearance(level, t), `turret at ${t.x},${t.y}`).toBeLessThan(1.5);
  });
});
