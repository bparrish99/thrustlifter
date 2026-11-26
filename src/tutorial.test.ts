import { describe, expect, it } from 'vitest';
import { Game, type FrameInput } from './game';
import { levelFile } from './levels';

// The shipped levels by file, so these tests don't depend on the play order or on the owner's level 1.
const PROVING_GROUND = levelFile('proving-ground.json')!;
const DEEP_CAVERNS = levelFile('deep-caverns.json')!;

const idle: FrameInput = { tiltAxis: 0, rotor: 0, dive: 0, fire: false, flip: false, pickup: false, pickupPressed: false, restart: false };
const run = (g: Game, input: FrameInput, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    g.update(input, 1 / 60);
    g.events.length = 0;
  }
};
const tick = (g: Game, n = 1) => {
  for (let i = 0; i < n; i++) g.tutorial!.update(g, 0.1);
};
const showing = (g: Game) => g.tutorial!.showing;

/** In the air, off the pad, with the lift-off hint already done. */
function flying(): Game {
  const g = new Game(PROVING_GROUND, { tutorial: true });
  g.tutorial!.seen.add('liftoff');
  g.onLaunchPad = false;
  g.heli.landed = false;
  return g;
}

describe('first-level tutorial', () => {
  it('only exists when asked for (level 1)', () => {
    expect(new Game(PROVING_GROUND, { tutorial: true }).tutorial).not.toBeNull();
    expect(new Game(DEEP_CAVERNS, { levelNumber: 2 }).tutorial).toBeNull();
  });

  it('starts with the lift-off hint, which goes once you take off and never comes back', () => {
    const g = new Game(PROVING_GROUND, { tutorial: true });
    run(g, idle, 0.5);
    expect(showing(g)).toContain('liftoff');
    run(g, { ...idle, rotor: 1 }, 1.5);
    run(g, idle, 1);
    expect(g.tutorial!.seen.has('liftoff')).toBe(true);
    expect(showing(g)).not.toContain('liftoff');
  });

  it('points at the orb when you come near it, until you tether it', () => {
    const g = flying();
    g.heli.pos = { x: g.orb.pos.x, y: g.orb.pos.y - 200 };
    tick(g);
    expect(showing(g)).toContain('orb');
    g.orb.attached = true;
    tick(g, 10);
    expect(g.tutorial!.seen.has('orb')).toBe(true);
    expect(showing(g)).not.toContain('orb');
  });
});

describe('hints are independent of each other', () => {
  it('a fuel tank next to the orb: both hints show at once, and each goes when its own job is done', () => {
    const g = flying();
    g.fuel = g.cfg.fuelMax * 0.8;
    const tank = g.fuelTanks[0].pos;
    g.orb.pos = { x: tank.x + 330, y: tank.y - 50 }; // like WELCOME TO THE JUGGLE: the orb just past a tank
    g.heli.pos = { x: tank.x + 150, y: tank.y - 200 };
    tick(g);
    expect(showing(g)).toEqual(expect.arrayContaining(['fuel', 'orb']));
    g.refueling = true;
    tick(g, 10);
    g.refueling = false;
    tick(g);
    expect(showing(g)).not.toContain('fuel');
    expect(showing(g)).toContain('orb');
  });

  it('the fuel hint stays quiet when your tank is full', () => {
    const g = flying();
    const tank = g.fuelTanks[0].pos;
    g.heli.pos = { x: tank.x + 150, y: tank.y - 200 };
    tick(g);
    expect(showing(g)).not.toContain('fuel');
  });

  it('after delivering next to a rescue pad: RESCUE HOSTAGES over the pad, fly back over the heli', () => {
    const g = flying();
    const pad = g.level.data.pads.find((p) => p.kind === 'rescue')!;
    g.heli.pos = { x: pad.x - 300, y: pad.y - 200 };
    g.orb.delivered = true;
    tick(g);
    expect(showing(g)).toEqual(expect.arrayContaining(['rescue', 'flyBack']));
    expect(g.tutorial!.views.find((v) => v.id === 'rescue')!.lines).toEqual(['RESCUE HOSTAGES']);
    tick(g, 200); // takes its time landing: the rescue hint stays
    expect(showing(g)).toContain('rescue');
    for (const s of g.survivors) s.state = 'aboard';
    tick(g, 10);
    expect(showing(g)).not.toContain('rescue');
  });
});

describe('fly back', () => {
  it('points the way to your pad, until the pad is in sight; then the landing hint takes over', () => {
    const g = flying();
    g.orb.delivered = true;
    g.heli.pos = { x: 3600, y: 500 }; // far right of the pad
    tick(g);
    expect(showing(g)).toContain('flyBack');
    expect(g.tutorial!.views.find((v) => v.id === 'flyBack')!.lines.join(' ')).toContain('◀');
    g.heli.pos = { x: 500, y: 600 }; // pad in sight
    tick(g, 10);
    expect(g.tutorial!.seen.has('flyBack')).toBe(true);
    expect(showing(g)).toContain('home');
  });
});

describe('hints get out of the way when you can do the thing', () => {
  it('the orb hint fades while the orb is in tether reach, and comes back if you move off', () => {
    const g = flying();
    g.heli.pos = { x: g.orb.pos.x, y: g.orb.pos.y - 400 };
    tick(g);
    expect(showing(g)).toContain('orb');
    g.heli.pos = { x: g.orb.pos.x, y: g.orb.pos.y - g.cfg.rodLength * 0.6 }; // in reach
    expect(g.orbInReach()).toBe(true);
    tick(g, 5);
    expect(showing(g)).not.toContain('orb');
    expect(g.tutorial!.seen.has('orb')).toBe(false); // not used up
    tick(g, 200); // hovering there a long time doesn't use it up either
    g.heli.pos = { x: g.orb.pos.x, y: g.orb.pos.y - 400 };
    tick(g, 5);
    expect(showing(g)).toContain('orb');
  });

  it('the fuel hint fades while a tank is in reach', () => {
    const g = flying();
    g.fuel = g.cfg.fuelMax * 0.5;
    const tank = g.fuelTanks[0].pos;
    g.heli.pos = { x: tank.x + 250, y: tank.y - 250 };
    tick(g);
    expect(showing(g)).toContain('fuel');
    g.heli.pos = { x: tank.x, y: tank.y - 80 };
    expect(g.tankInReach()).not.toBeNull();
    tick(g, 5);
    expect(showing(g)).not.toContain('fuel');
  });
});
