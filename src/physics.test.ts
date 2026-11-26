import { describe, expect, it } from 'vitest';
import { DEFAULTS } from './config';
import { Game, STEP, TANK_H, type FrameInput } from './game';
import provingGround from './levels/proving-ground.json';
import type { LevelData } from './level';
import { deg, dist, distPointSegment, segmentsIntersect } from './math';
import { LEVELS } from './levels';
import { buildLevel, segmentsNear, type Level } from './level';
import { ANCHOR, createHeli, heliPoint, integrate, noseDir, rotorNormal, solveRod, thrustForce, type Body } from './physics';

const cfg = { ...DEFAULTS };
/** Proving Ground with its rescue-pad guards removed (for tests about landing there). */
const noGuards = { ...(provingGround as LevelData), pads: (provingGround as LevelData).pads.map((p) => ({ ...p, guards: 0 })) } as LevelData;
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
    g.heli.landed = false; g.onLaunchPad = false;
    g.heli.pos = { x: orb.pos.x, y: orb.pos.y - 19 - 80 };
    g.heli.vel = { x: 0, y: -60 };
    g.heli.throttle = 1;
    for (let i = 0; i < 40 && !orb.attached; i++) g.update({ ...idle, rotor: 1, pickup: true }, 1 / 60);
    expect(orb.attached).toBe(true);
    expect(g.phase).toBe('playing');
  });

  it('crashes when flown into the ground', () => {
    const g = new Game(provingGround as LevelData);
    g.heli.landed = false; g.onLaunchPad = false;
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
    g.heli.landed = false; g.onLaunchPad = false;
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
      g.heli.landed = false; g.onLaunchPad = false;
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
    g.heli.landed = false; g.onLaunchPad = false;
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
    g.heli.landed = false; g.onLaunchPad = false;
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
    g.heli.landed = false; g.onLaunchPad = false;
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
    g.heli.landed = false; g.onLaunchPad = false;
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
    g.heli.landed = false; g.onLaunchPad = false;
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
      g.heli.landed = false; g.onLaunchPad = false;
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
    const g = new Game(noGuards);
    g.balloons = []; // turrets only
    g.heli.landed = false; g.onLaunchPad = false;
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
    g.heli.landed = false; g.onLaunchPad = false;
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

  it('no turret or balloon can see any part of the carry route (enemies only on the way in and home)', () => {
    sealGate.open = false;
    exitGate.open = false;
    // eyes: every turret, plus each balloon's gun anywhere around its drift loop
    const eyes: { name: string; eye: { x: number; y: number }; range: number }[] = LEVELS[1].turrets.map((t) => {
      const a = deg(t.dir ?? -90);
      return { name: `turret at ${t.x},${t.y}`, eye: { x: t.x + Math.cos(a) * 8, y: t.y + Math.sin(a) * 8 }, range: cfg.turretRange };
    });
    for (const b of LEVELS[1].balloons ?? []) {
      const r = b.patrol ?? cfg.balloonPatrol;
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        eyes.push({ name: `balloon at ${b.x},${b.y}`, eye: { x: b.x + Math.cos(a) * r, y: b.y + Math.sin(a) * r * 0.5 + 52 }, range: cfg.balloonFireRange });
      }
    }
    for (const { name, eye, range } of eyes) {
      const t = { x: Math.round(eye.x), y: Math.round(eye.y) };
      for (let i = 0; i + 1 < CARRY.length; i++) {
        for (let k = 0; k <= 10; k++) {
          const [ax, ay] = CARRY[i];
          const [bx, by] = CARRY[i + 1];
          const p = { x: ax + ((bx - ax) * k) / 10, y: ay + ((by - ay) * k) / 10 };
          for (const q of [p, { x: p.x, y: p.y + ORB_DROP }]) {
            const seen = dist(eye, q) < range && lineOfSight(eye, q);
            expect(seen, `${name} (eye ${t.x},${t.y}) sees ${Math.round(q.x)},${Math.round(q.y)}`).toBe(false);
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

describe('checkpoints (internal)', () => {
  it('dying after delivery respawns you hovering above the bowl, held until you touch the controls', () => {
    const g = new Game(provingGround as LevelData);
    g.orb.delivered = true;
    g.heli.landed = false; g.onLaunchPad = false;
    g.heli.pos = { x: 700, y: 600 };
    g.heli.vel = { x: 0, y: 400 };
    for (let i = 0; i < 4 * 60; i++) g.update(idle, 1 / 60); // crash, then wait out the respawn
    expect(g.phase).toBe('playing');
    expect(g.held).toBe(true);
    expect(g.heli.landed).toBe(false);
    expect(Math.abs(g.heli.pos.x - g.level.bowl.cx)).toBeLessThan(1);
    const y0 = g.heli.pos.y;
    for (let i = 0; i < 60; i++) g.update(idle, 1 / 60);
    expect(g.heli.pos.y).toBe(y0); // hangs in place, no gravity
    g.update({ ...idle, tiltAxis: 1 }, 1 / 60);
    expect(g.held).toBe(false);
    for (let i = 0; i < 30; i++) g.update(idle, 1 / 60);
    expect(g.heli.pos.y).toBeGreaterThan(y0); // now gravity applies
  });

  it('dying before delivery still sends you back to the launch pad', () => {
    const g = new Game(provingGround as LevelData);
    g.heli.landed = false; g.onLaunchPad = false;
    g.heli.pos = { x: 700, y: 600 };
    g.heli.vel = { x: 0, y: 400 };
    for (let i = 0; i < 4 * 60; i++) g.update(idle, 1 / 60);
    expect(g.heli.landed).toBe(true);
    expect(g.held).toBe(false);
  });
});

describe('fuel and shield', () => {
  const airborne = () => {
    const g = new Game(provingGround as LevelData);
    g.heli.landed = false; g.onLaunchPad = false;
    g.heli.pos = { x: 1300, y: 200 };
    return g;
  };

  it('thrust burns fuel; running dry means no thrust', () => {
    const g = airborne();
    const f0 = g.fuel;
    for (let i = 0; i < 60; i++) g.update({ ...idle, rotor: 1 }, 1 / 60);
    expect(g.fuel).toBeLessThan(f0 - cfg.fuelBurn * 0.9);
    g.fuel = 0;
    g.heli.vel = { x: 0, y: 0 };
    for (let i = 0; i < 30; i++) g.update({ ...idle, rotor: 1 }, 1 / 60);
    expect(g.heli.throttle).toBe(0);
    expect(g.heli.vel.y).toBeGreaterThan(0); // falling
  });

  it('hovering over a fuel tank holding Space sucks it up until it runs dry', () => {
    // Proving Ground tank at (1300, 830)
    const g = new Game(provingGround as LevelData);
    const tank = g.fuelTanks.find((t) => t.pos.x === 1300)!;
    g.fuel = 10;
    g.heli.landed = false; g.onLaunchPad = false;
    let seconds = 0;
    for (let i = 0; i < 3 * 60 && tank.alive; i++, seconds += 1 / 60) {
      g.heli.pos = { x: 1300, y: 830 - TANK_H - 90 };
      g.heli.vel = { x: 0, y: 0 };
      g.update({ ...idle, pickup: true }, 1 / 60);
    }
    expect(tank.alive).toBe(false); // drained tanks disappear
    expect(g.fuel).toBeGreaterThan(10 + cfg.tankAmount - 1); // got the whole tank: no shield burn while fuelling
    expect(seconds).toBeGreaterThan(0);
  });

  it('Space near a tank never raises the shield, and it stays off after the tank runs dry until Space is pressed again', () => {
    const g = new Game(provingGround as LevelData);
    const tank = g.fuelTanks.find((t) => t.pos.x === 1300)!;
    g.fuel = 10;
    g.heli.landed = false; g.onLaunchPad = false;
    const hover = (input: Partial<FrameInput>) => {
      g.heli.pos = { x: 1300, y: 830 - TANK_H - 90 };
      g.heli.vel = { x: 0, y: 0 };
      g.update({ ...idle, ...input }, 1 / 60);
    };
    hover({ pickup: true, pickupPressed: true });
    expect(g.refueling).toBe(true);
    expect(g.shield).toBe(false);
    for (let i = 0; i < 3 * 60 && tank.alive; i++) hover({ pickup: true });
    expect(tank.alive).toBe(false);
    for (let i = 0; i < 20; i++) hover({ pickup: true }); // still holding Space
    expect(g.shield).toBe(false);
    hover({}); // let go
    hover({ pickup: true, pickupPressed: true }); // press again
    expect(g.shield).toBe(true);
  });

  it('fuel tanks can be shot', () => {
    const g = new Game(provingGround as LevelData);
    const tank = g.fuelTanks.find((t) => t.pos.x === 1300)!;
    g.projectiles.push({ kind: 'missile', pos: { x: 1230, y: 830 - TANK_H / 2 }, vel: { x: 600, y: 0 }, life: 1, dir: { x: 1, y: 0 }, base: { x: 0, y: 0 }, speed: 600 });
    for (let i = 0; i < 30; i++) g.update(idle, 1 / 60);
    expect(tank.alive).toBe(false);
  });

  it('pads do not refuel; each survivor who climbs aboard adds a little fuel', () => {
    const g = new Game(noGuards);
    g.fuel = 20;
    g.heli.landed = false; g.onLaunchPad = false;
    g.heli.pos = { x: 3080, y: 825 };
    g.heli.vel = { x: 0, y: 20 };
    g.heli.tilt = g.heli.tiltTarget = 0;
    for (let i = 0; i < 60 && !g.heli.landed; i++) g.update({ ...idle, rotor: 0.3 }, 1 / 60);
    const landedFuel = g.fuel;
    expect(landedFuel).toBeLessThan(21); // no pad refuel/boost
    for (let i = 0; i < 3 * 60; i++) g.update(idle, 1 / 60); // both survivors run over and board
    expect(g.survivors.every((s) => s.state === 'aboard')).toBe(true);
    expect(g.fuel).toBeCloseTo(landedFuel + 2 * cfg.rescueFuelBoost, 0);
  });

  it('no refuel on death: you keep your fuel, topped up only to the checkpoint minimum', () => {
    const crashWith = (fuel: number) => {
      const g = new Game(provingGround as LevelData);
      g.fuel = fuel;
      g.heli.landed = false; g.onLaunchPad = false;
      g.heli.pos = { x: 700, y: 600 };
      g.heli.vel = { x: 0, y: 400 };
      for (let i = 0; i < 4 * 60; i++) g.update(idle, 1 / 60);
      return g.fuel;
    };
    const min = (provingGround as LevelData).startFuelMin!;
    expect(crashWith(80)).toBeLessThan(81); // kept, not refilled
    expect(crashWith(80)).toBeGreaterThan(70);
    expect(crashWith(0)).toBeCloseTo(min, 0); // topped up to the minimum
  });

  it('holding Space raises a shield that burns fuel and absorbs enemy shots', () => {
    const g = airborne();
    g.turrets.forEach((t) => (t.alive = false));
    const f0 = g.fuel;
    g.update({ ...idle, rotor: 0.5, pickup: true }, 1 / 60);
    expect(g.shield).toBe(true);
    g.projectiles.push({ kind: 'enemy', pos: { x: 1300, y: 300 }, vel: { x: 0, y: -300 }, life: 2 });
    for (let i = 0; i < 30; i++) g.update({ ...idle, rotor: 0.5, pickup: true }, 1 / 60);
    expect(g.phase).toBe('playing');
    expect(g.projectiles.filter((p) => p.kind === 'enemy').length).toBe(0);
    expect(g.fuel).toBeLessThan(f0 - cfg.shieldBurn * 0.4);
  });

  it('no shield while carrying the orb (Space releases instead)', () => {
    const g = airborne();
    g.orb.attached = true;
    g.orb.pos = { x: 1300, y: 200 + 16 + cfg.rodLength };
    g.update({ ...idle, pickup: true }, 1 / 60);
    expect(g.shield).toBe(false);
  });
});

describe('survivors', () => {
  // Proving Ground: fuel pad at x 3020..3140 (top 850), survivors at x 3165 and 3185 on ground y 860.
  const landOnFuelPad = (g: Game) => {
    g.heli.landed = false; g.onLaunchPad = false;
    g.heli.pos = { x: 3080, y: 790 };
    g.heli.vel = { x: 0, y: 40 };
    g.heli.tilt = g.heli.tiltTarget = 0;
    for (let i = 0; i < 60 && !g.heli.landed; i++) g.update({ ...idle, rotor: 0.3 }, 1 / 60);
  };

  it('run to the heli when it lands nearby and climb aboard', () => {
    const g = new Game(noGuards);
    landOnFuelPad(g);
    expect(g.heli.landed).toBe(true);
    for (let i = 0; i < 3 * 60; i++) g.update(idle, 1 / 60);
    expect(g.survivors.every((s) => s.state === 'aboard')).toBe(true);
  });

  it('are counted as rescued when you land back on your pad, and lost if you crash with them', () => {
    const g = new Game(noGuards);
    g.survivors[0].state = 'aboard';
    g.survivors[1].state = 'aboard';
    g.heli.landed = false; g.onLaunchPad = false;
    g.heli.pos = { x: 280, y: 790 };
    g.heli.vel = { x: 0, y: 40 };
    for (let i = 0; i < 60 && !g.heli.landed; i++) g.update({ ...idle, rotor: 0.3 }, 1 / 60);
    expect(g.survivors.every((s) => s.state === 'rescued')).toBe(true);

    const g2 = new Game(noGuards);
    g2.survivors[0].state = 'aboard';
    g2.heli.landed = false; g2.onLaunchPad = false;
    g2.heli.pos = { x: 700, y: 600 };
    g2.heli.vel = { x: 0, y: 400 };
    for (let i = 0; i < 60 && g2.phase === 'playing'; i++) g2.update(idle, 1 / 60);
    expect(g2.survivors[0].state).toBe('lost');
  });
});

describe('level sanity', () => {
  it('no fuel tank sits close enough to an orb for Space to reach both', () => {
    for (const data of LEVELS) {
      for (const t of data.fuelTanks ?? []) {
        // to use a tank you must be within 45 sideways of it; the tether reaches rodLength
        const d = Math.abs(t.x - data.orb.x);
        expect(d, `${data.name}: tank at ${t.x},${t.y} is ${Math.round(d)} sideways from the orb`).toBeGreaterThan(cfg.rodLength + 45 + 40);
      }
    }
  });
});

describe('shield vs tether', () => {
  it('no shield while the orb is within tether reach, nor after leaving it until Space is pressed again', () => {
    const g = new Game(provingGround as LevelData);
    g.heli.landed = false; g.onLaunchPad = false;
    const at = (y: number, input: Partial<FrameInput>) => {
      g.heli.pos = { x: g.orb.home.x, y };
      g.heli.vel = { x: 0, y: 0 };
      g.update({ ...idle, ...input }, 1 / 60);
    };
    at(g.orb.home.y - 100, { pickup: true, pickupPressed: true }); // anchor ~84 from the orb: in reach
    expect(g.beam).toBe(true);
    expect(g.shield).toBe(false);
    at(g.orb.home.y - 400, { pickup: true }); // out of reach, still holding
    expect(g.shield).toBe(false);
    at(g.orb.home.y - 400, {});
    at(g.orb.home.y - 400, { pickup: true, pickupPressed: true });
    expect(g.shield).toBe(true);
  });
});

describe('Space never switches abilities mid-press', () => {
  it('a press that starts as a shield stays a shield over a tank and near the orb', () => {
    const g = new Game(provingGround as LevelData);
    g.fuel = 50;
    g.heli.landed = false; g.onLaunchPad = false;
    const at = (x: number, y: number, input: Partial<FrameInput>) => {
      g.heli.pos = { x, y };
      g.heli.vel = { x: 0, y: 0 };
      g.update({ ...idle, ...input }, 1 / 60);
    };
    at(1300, 300, { pickup: true, pickupPressed: true }); // open sky: shield
    expect(g.shield).toBe(true);
    at(1300, 830 - TANK_H - 90, { pickup: true }); // now over the tank
    expect(g.refueling).toBe(false);
    expect(g.shield).toBe(true);
    at(g.orb.home.x, g.orb.home.y - 100, { pickup: true }); // now in orb range
    expect(g.beam).toBe(false);
    expect(g.orb.attached).toBe(false);
    expect(g.shield).toBe(true);
  });
});

describe('guard helicopters', () => {
  // Proving Ground rescue pad (x 3020..3140, top 850) has 2 guards.
  const hoverAt = (g: Game, x: number, y: number, seconds: number, input: Partial<FrameInput> = {}) => {
    for (let i = 0; i < seconds * 60 && g.phase === 'playing'; i++) {
      g.heli.landed = false; g.onLaunchPad = false;
      g.heli.pos = { x, y };
      g.heli.vel = { x: 0, y: 0 };
      g.update({ ...idle, ...input }, 1 / 60);
    }
  };

  it('stay parked on their pad while you are far away', () => {
    const g = new Game(provingGround as LevelData);
    g.turrets.forEach((t) => (t.alive = false));
    g.balloons = [];
    hoverAt(g, 1300, 300, 2);
    expect(g.enemies.length).toBe(1);
    expect(g.enemies[0].state).toBe('parked');
  });

  it('launch when you come near, telegraph, and can shoot you down', () => {
    const g = new Game(provingGround as LevelData);
    g.turrets.forEach((t) => (t.alive = false));
    g.balloons = [];
    let sawCharge = false;
    for (let i = 0; i < 12 * 60 && g.phase === 'playing'; i++) {
      g.heli.landed = false; g.onLaunchPad = false;
      g.heli.pos = { x: 2950, y: 450 };
      g.heli.vel = { x: 0, y: 0 };
      g.update(idle, 1 / 60);
      if (g.enemies.some((e) => e.charge > 0.3)) sawCharge = true;
    }
    expect(sawCharge).toBe(true);
    expect(g.phase).toBe('dead');
    expect(g.lastCrash).toBe('SHOT DOWN');
  });

  it('one missile downs a guard; the next launches after a delay; then the pad is clear', () => {
    const g = new Game(provingGround as LevelData);
    g.turrets.forEach((t) => (t.alive = false));
    g.balloons = [];
    hoverAt(g, 1300, 300, 0.1);
    const first = g.enemies[0];
    g.projectiles.push({ kind: 'missile', pos: { x: first.pos.x - 60, y: first.pos.y }, vel: { x: 700, y: 0 }, life: 1, dir: { x: 1, y: 0 }, base: { x: 0, y: 0 }, speed: 700 });
    hoverAt(g, 1300, 300, 0.3);
    expect(first.alive).toBe(false);
    expect(g.enemies.length).toBe(0);
    hoverAt(g, 1300, 300, cfg.enemyRespawn + 0.5);
    expect(g.enemies.length).toBe(1); // second guard
    g.destroyEnemy(g.enemies[0]);
    hoverAt(g, 1300, 300, cfg.enemyRespawn * 2);
    expect(g.enemies.length).toBe(0); // only 2 guards on this pad
  });

  it('the next guard waits to appear until you are clear of its pad', () => {
    const g = new Game(provingGround as LevelData);
    g.turrets.forEach((t) => (t.alive = false));
    g.balloons = [];
    hoverAt(g, 1300, 300, 0.1);
    g.destroyEnemy(g.enemies[0]);
    hoverAt(g, 3080, 700, cfg.enemyRespawn + 2); // hanging right over the pad
    expect(g.enemies.length).toBe(0);
    hoverAt(g, 1300, 300, 0.2); // move away
    expect(g.enemies.length).toBe(1);
  });

  it('no more guards come once that pad\'s survivors have been picked up', () => {
    const g = new Game(provingGround as LevelData);
    g.turrets.forEach((t) => (t.alive = false));
    g.balloons = [];
    hoverAt(g, 1300, 300, 0.1);
    g.destroyEnemy(g.enemies[0]);
    g.survivors.forEach((sv) => (sv.state = 'aboard'));
    hoverAt(g, 1300, 300, cfg.enemyRespawn * 2);
    expect(g.enemies.length).toBe(0);
  });

  it('guards set to wake after delivery stay parked until the orb is delivered', () => {
    const data = { ...noGuards, pads: noGuards.pads.map((p) => (p.kind === 'rescue' ? { ...p, guards: 1, guardsAfter: 'delivery' as const } : p)) };
    const g = new Game(data);
    g.turrets.forEach((t) => (t.alive = false));
    g.balloons = [];
    hoverAt(g, 1300, 300, 0.1); // guard is placed while you're far away
    hoverAt(g, 2900, 600, 3);
    expect(g.enemies[0].state).toBe('parked');
    g.orb.delivered = true;
    hoverAt(g, 2900, 600, 0.5);
    expect(g.enemies[0].state).not.toBe('parked');
  });
});

describe('balloons', () => {
  it('drift around, shoot at you, and pop from one missile', () => {
    const g = new Game(noGuards);
    g.turrets.forEach((t) => (t.alive = false));
    const b = g.balloons[0]; // Proving Ground balloon around (900, 360)
    const start = { ...b.pos };
    let shots = 0;
    for (let i = 0; i < 8 * 60 && g.phase === 'playing'; i++) {
      g.heli.landed = false; g.onLaunchPad = false;
      g.heli.pos = { x: 1150, y: 500 };
      g.heli.vel = { x: 0, y: 0 };
      g.update({ ...idle, pickup: true, pickupPressed: i === 0 }, 1 / 60); // shield up so we survive
      if (g.events.some((e) => e.type === 'enemyShot')) shots++;
      g.events.length = 0;
    }
    expect(dist(b.pos, start)).toBeGreaterThan(20); // it moved
    expect(shots).toBeGreaterThan(0);
    g.projectiles.push({ kind: 'missile', pos: { x: b.pos.x - 80, y: b.pos.y }, vel: { x: 800, y: 0 }, life: 1, dir: { x: 1, y: 0 }, base: { x: 0, y: 0 }, speed: 800 });
    g.update(idle, 1 / 10);
    g.update(idle, 1 / 10);
    expect(b.alive).toBe(false);
  });
});

describe('no soft-locks', () => {
  it('landing with an empty tank strands you: no explosion, respawn with the checkpoint fuel minimum', () => {
    const g = new Game(noGuards);
    g.balloons = [];
    g.turrets.forEach((t) => (t.alive = false));
    g.survivors[0].state = 'aboard';
    g.fuel = 0;
    for (let i = 0; i < 2 * 60; i++) g.update(idle, 1 / 60); // sitting on the start pad, dry
    expect(g.phase).toBe('playing');
    for (let i = 0; i < 2 * 60; i++) g.update(idle, 1 / 60);
    expect(g.lastCrash).toBe('STRANDED');
    expect(g.survivors[0].state).toBe('waiting'); // climbed back out, not lost
    for (let i = 0; i < 3 * 60; i++) g.update(idle, 1 / 60);
    expect(g.phase).toBe('playing');
    expect(g.fuel).toBeGreaterThanOrEqual((provingGround as LevelData).startFuelMin! - 0.01);
  });

  it('each level defines fuel minimums for its respawn points', () => {
    for (const d of LEVELS) {
      expect(d.startFuelMin, d.name).toBeGreaterThan(0);
      expect(d.checkpoints?.find((c) => c.after === 'delivery')?.fuel, d.name).toBeGreaterThan(0);
    }
  });

  it('after delivery you respawn with at least that checkpoint\'s fuel', () => {
    const g = new Game(LEVELS[1]);
    g.orb.delivered = true;
    g.fuel = 0;
    g.heli.landed = false; g.onLaunchPad = false;
    g.heli.pos = { x: 860, y: 700 };
    g.heli.vel = { x: 0, y: 900 };
    for (let i = 0; i < 4 * 60; i++) g.update(idle, 1 / 60);
    expect(g.held).toBe(true);
    expect(g.fuel).toBeGreaterThanOrEqual(LEVELS[1].checkpoints![0].fuel! - 0.01);
  });
});

describe('scoring', () => {
  it('turret 100, balloon 200, guard 300 for player kills', () => {
    const g = new Game(provingGround as LevelData);
    const missileAt = (x: number, y: number) =>
      g.projectiles.push({ kind: 'missile', pos: { x: x - 60, y }, vel: { x: 800, y: 0 }, life: 1, dir: { x: 1, y: 0 }, base: { x: 0, y: 0 }, speed: 800 });
    g.heli.landed = false; g.onLaunchPad = false;
    g.heli.pos = { x: 280, y: -900 }; // far out of everyone's way
    const t = g.turrets[0];
    missileAt(t.pos.x, t.pos.y - 11);
    for (let i = 0; i < 10; i++) g.update(idle, 1 / 60);
    expect(g.score).toBe(100);
    const b = g.balloons[0];
    g.balloons.forEach((x) => (x.t = 0));
    missileAt(b.pos.x, b.pos.y);
    for (let i = 0; i < 10; i++) g.update(idle, 1 / 60);
    expect(g.score).toBe(300);
    const e = g.enemies[0];
    missileAt(e.pos.x, e.pos.y);
    for (let i = 0; i < 10; i++) g.update(idle, 1 / 60);
    expect(g.score).toBe(600);
  });

  it('500 per survivor rescued, and 10 per tenth of a second under the target time', () => {
    const g = new Game(noGuards);
    g.balloons = [];
    g.turrets.forEach((t) => (t.alive = false));
    g.survivors.forEach((s) => (s.state = 'aboard'));
    g.orb.delivered = true;
    g.heli.landed = false; g.onLaunchPad = false;
    g.heli.pos = { x: 280, y: 790 };
    g.heli.vel = { x: 0, y: 40 };
    for (let i = 0; i < 60 && !g.heli.landed; i++) g.update({ ...idle, rotor: 0.3 }, 1 / 60);
    expect(g.phase).toBe('complete');
    const bonus = g.timeBonus;
    expect(bonus).toBeGreaterThan(0);
    const fuelAtLanding = g.fuel;
    expect(g.score).toBe(2 * 500); // bonuses not paid yet: the tally pays them out
    for (let i = 0; i < 12 * 60 && g.tally!.stage !== 'done'; i++) g.update(idle, 1 / 60);
    expect(g.tally!.stage).toBe('done');
    expect(g.bonusTime).toBe(0);
    expect(g.fuel).toBe(0);
    expect(g.timeBonus).toBe(bonus);
    const fuelBonus = Math.floor((fuelAtLanding / cfg.fuelMax) * 24 + 1e-6) * 25;
    expect(g.fuelBonus).toBe(fuelBonus);
    expect(fuelBonus).toBeGreaterThan(0);
    expect(g.score).toBe(2 * 500 + bonus + fuelBonus);
  });
});

describe('extra lives', () => {
  it('an extra life every 10,000 points', () => {
    const g = new Game(provingGround as LevelData);
    const l0 = g.lives;
    g.award(9900, { x: 0, y: 0 });
    expect(g.lives).toBe(l0);
    g.award(100, { x: 0, y: 0 });
    expect(g.lives).toBe(l0 + 1);
    g.award(20000, { x: 0, y: 0 });
    expect(g.lives).toBe(l0 + 3);
  });
});

describe('bonus time', () => {
  it('counts down only after lift-off, and stops at zero', () => {
    const g = new Game(provingGround as LevelData);
    const target = (provingGround as LevelData).targetTime!;
    for (let i = 0; i < 120; i++) g.update(idle, 1 / 60); // sitting on the pad
    expect(g.bonusTime).toBe(target);
    for (let i = 0; i < 60; i++) g.update({ ...idle, rotor: 1 }, 1 / 60);
    expect(g.bonusTime).toBeLessThan(target);
    g.bonusTime = 0.1;
    for (let i = 0; i < 60; i++) g.update(idle, 1 / 60);
    expect(g.bonusTime).toBe(0);
  });
});

describe('safe before launch', () => {
  it('enemies hold fire and shots cannot hurt you until you lift off', () => {
    const g = new Game(provingGround as LevelData);
    // a turret right next to the pad, with clear sight
    g.turrets[0].pos = { x: 600, y: 860 };
    g.turrets[0].cooldown = 0;
    for (let i = 0; i < 4 * 60; i++) g.update(idle, 1 / 60);
    expect(g.projectiles.filter((p) => p.kind === 'enemy').length).toBe(0);
    g.projectiles.push({ kind: 'enemy', pos: { x: g.heli.pos.x + 80, y: g.heli.pos.y }, vel: { x: -300, y: 0 }, life: 2 });
    for (let i = 0; i < 60; i++) g.update(idle, 1 / 60);
    expect(g.phase).toBe('playing');
    expect(g.onLaunchPad).toBe(true);
    g.update({ ...idle, rotor: 1 }, 1 / 60);
    for (let i = 0; i < 30; i++) g.update({ ...idle, rotor: 1 }, 1 / 60);
    expect(g.onLaunchPad).toBe(false);
  });
});

describe('after mission complete', () => {
  it('nothing can shoot you down while you sit on the pad', () => {
    const g = new Game(LEVELS[0]);
    g.orb.delivered = true;
    g.heli.landed = false;
    g.onLaunchPad = false;
    g.heli.pos = { x: 280, y: 830 };
    g.heli.vel = { x: 0, y: 20 };
    for (let i = 0; i < 25 * 60; i++) g.update(idle, 1 / 60);
    expect(g.phase).toBe('complete');
    expect(g.deaths).toBe(0);
    expect(g.projectiles.filter((p) => p.kind === 'enemy').length).toBe(0);
  });
});

describe('level progression', () => {
  it('after the results pause, the game asks for the next level', () => {
    const g = new Game(LEVELS[0], { levelNumber: 1, hasNextLevel: true });
    g.orb.delivered = true;
    g.heli.landed = false;
    g.onLaunchPad = false;
    g.heli.pos = { x: 280, y: 830 };
    g.heli.vel = { x: 0, y: 20 };
    let doneAt = -1;
    for (let i = 0; i < 30 * 60 && !g.readyForNext; i++) {
      g.update(idle, 1 / 60);
      if (doneAt < 0 && g.tally?.stage === 'done') doneAt = i;
    }
    expect(g.readyForNext).toBe(true);
    expect(doneAt).toBeGreaterThan(0);
  });

  it('on the last level it stays on the results', () => {
    const g = new Game(LEVELS[1], { levelNumber: 2, hasNextLevel: false });
    g.orb.delivered = true;
    g.completedAt = null;
    (g as unknown as { complete(): void }).complete();
    for (let i = 0; i < 20 * 60; i++) g.update(idle, 1 / 60);
    expect(g.readyForNext).toBe(false);
  });
});

describe('smarter guards', () => {
  // Deep Caverns orb-chamber guard (pad x 1150..1260 at y 1440) hunting a heli that moves around the cave.
  const caveGame = () => {
    const g = new Game(LEVELS[1]);
    g.turrets.forEach((t) => (t.alive = false));
    g.balloons = [];
    g.update(idle, 1 / 60); // guards appear on their pads while you're still far away on the launch pad
    g.heli.landed = false;
    g.onLaunchPad = false;
    return g;
  };
  const park = (g: Game, x: number, y: number, seconds: number, shield = true) => {
    for (let i = 0; i < seconds * 60 && g.phase === 'playing'; i++) {
      g.heli.pos = { x, y };
      g.heli.vel = { x: 0, y: 0 };
      g.fuel = 100;
      g.update({ ...idle, pickup: shield, pickupPressed: shield && i === 0 }, 1 / 60);
    }
  };

  it('a hunting guard never flies into the cave walls', () => {
    const g = caveGame();
    // wake it from the chamber, then lead it around the cave
    const route: [number, number, number][] = [[900, 1250, 4], [1300, 1260, 3], [1600, 1250, 3], [2025, 1260, 3], [2025, 1700, 4], [2600, 1800, 4]];
    let lost = 0;
    for (const [x, y, s] of route) {
      park(g, x, y, s);
      if (g.enemies.length === 0) lost++;
    }
    expect(g.events.filter((e) => e.type === 'turretDown').length).toBe(0); // no guard wrecks
    expect(lost).toBe(0);
  });

  it('routes around rock to chase you out of sight (follows you down the drop shaft)', () => {
    const g = caveGame();
    park(g, 1300, 1260, 4); // wake it, it hunts in the upper passage
    expect(g.enemies[0].state).toBe('hunting');
    park(g, 2025, 1780, 6); // duck down the drop shaft, out of its sight
    const e = g.enemies[0];
    expect(e).toBeDefined();
    expect(e.pos.y).toBeGreaterThan(1350); // it came down after you
  });

  it('builds a nav route through the caverns from the orb chamber to the bowl chamber', () => {
    const g = caveGame();
    const path = g.navPath({ x: 1000, y: 1250 }, { x: 3800, y: 1950 });
    expect(path.length).toBeGreaterThan(20);
    for (const p of path) expect(g.clearance(p)).toBeGreaterThan(30);
  });
});

describe('turret mounting', () => {
  const base = LEVELS[0];
  const withTurret = (x: number, y: number, dir?: number) => new Game({ ...base, turrets: [{ x, y, dir }] });

  it('aligns to a slope', () => {
    // Proving Ground slope from (980,610) down to (1080,650): turret dropped on it with no direction
    const g = withTurret(1030, 630);
    const n = g.turrets[0].normal;
    const t = { x: 100, y: 40 };
    expect(Math.abs(n.x * t.x + n.y * t.y)).toBeLessThan(1e-6); // perpendicular to the slope
    expect(n.y).toBeLessThan(0); // facing up out of the ground
  });

  it('aligns to a wall and a ceiling, ignoring a wrong direction hint', () => {
    const wall = withTurret(130, 300, -90); // left cliff face, hint says "up"
    expect(wall.turrets[0].normal.x).toBeGreaterThan(0.9);
    const roof = withTurret(2700, 505, -90); // underside of the floating rock
    expect(roof.turrets[0].normal.y).toBeGreaterThan(0.5);
  });

  it('sits on a pad top', () => {
    const pad = base.pads[0];
    const g = withTurret(pad.x + 40, pad.y);
    expect(g.turrets[0].normal.y).toBeLessThan(-0.99);
  });
});
