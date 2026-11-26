import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../config';
import { buildLevel } from '../level';
import order from '../levels/order.json';
import { ALL_LEVEL_FILES, LEVELS, LEVEL_FILES, SHELVED_LEVEL_FILES, levelFile } from '../levels';
import { cutRock, cutsThroughRock, outlinePos, padHostages, strayHostages, tankOrbConflict, formatLevel, groundBelow, nearestSurface, newLevelTemplate, slugFile, snapToGround, tightSpots, validate } from './tools';

const cfg = { ...DEFAULTS };

describe('level list', () => {
  it('loads the levels in order.json order', () => {
    expect(LEVEL_FILES).toEqual((order as string[]).filter((f) => ALL_LEVEL_FILES.includes(f)));
    expect(LEVELS.map((l) => l.name)).toEqual(LEVEL_FILES.map((f) => levelFile(f)!.name));
  });

  it('every level file is either played or on the shelf', () => {
    expect([...LEVEL_FILES, ...SHELVED_LEVEL_FILES].sort()).toEqual(ALL_LEVEL_FILES);
    for (const f of ALL_LEVEL_FILES) expect(levelFile(f)?.name, f).toBeTruthy();
  });
});

describe('editor tools', () => {
  const t = newLevelTemplate();

  it('the new-level template is valid and builds', () => {
    expect(validate(t, cfg).filter((p) => p.level === 'error')).toEqual([]);
    expect(() => buildLevel(t)).not.toThrow();
  });

  it('the shipped levels pass validation', () => {
    for (const l of LEVELS) expect(validate(l, cfg).filter((p) => p.level === 'error'), l.name).toEqual([]);
  });

  it('snaps to the ground below, or up out of rock', () => {
    expect(groundBelow(t, { x: 1000, y: 300 })).toBeCloseTo(800);
    expect(snapToGround(t, { x: 1000, y: 820 })).toBeCloseTo(800); // dragged slightly into the ground
  });

  it('finds the nearest surface with an outward normal (floor faces up, wall faces inward)', () => {
    const floor = nearestSurface(t, { x: 1000, y: 760 })!;
    expect(floor.normal.y).toBeLessThan(-0.9);
    const wall = nearestSurface(t, { x: 180, y: 300 })!;
    expect(wall.normal.x).toBeGreaterThan(0.9);
  });

  it('flags a tank too close to the orb, a missing launch pad, and missing fuel minimums', () => {
    const bad = { ...t, pads: [], startFuelMin: undefined, fuelTanks: [{ x: t.orb.x + 50, y: 800 }] };
    const msgs = validate(bad, cfg).map((p) => p.text).join(' | ');
    expect(msgs).toMatch(/launch pad/);
    expect(msgs).toMatch(/fuel tank/);
    expect(msgs).toMatch(/minimum fuel/);
  });

  it('formats JSON readably and round-trips', () => {
    const s = formatLevel(levelFile('deep-caverns.json')!);
    expect(s).toMatch(/\n {6}0, 2700,\n/);
    expect(JSON.parse(s)).toEqual(JSON.parse(JSON.stringify(levelFile('deep-caverns.json'))));
  });

  it('turns level names into file names', () => {
    expect(slugFile('Deep Caverns II!')).toBe('deep-caverns-ii.json');
  });

  it('marks a squeeze too narrow for the heli as tight, and a low tunnel as too low for the orb', () => {
    const squeeze = { ...t, terrain: [...t.terrain, [1000, 680, 1100, 680, 1100, 740, 1000, 740]] }; // 60 above the floor
    expect(tightSpots(squeeze, 95, 200).some((s) => s.level === 'tight' && s.p.x > 1000 && s.p.x < 1100)).toBe(true);
    const tunnel = { ...t, terrain: [...t.terrain, [1400, 650, 1700, 650, 1700, 660, 1400, 660]] }; // 140 above the floor
    const spots = tightSpots(tunnel, 95, 200).filter((s) => s.p.x > 1420 && s.p.x < 1680 && s.p.y > 660);
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.every((s) => s.level === 'snug')).toBe(true);
    expect(tightSpots(t, 95, 200).filter((s) => s.p.x > 300 && s.p.x < 2700 && s.p.y < 790).length).toBe(0); // open level: nothing
  });
});

describe('fuel tank vs orb check', () => {
  const orb = { x: 1000, y: 800 };
  it('flags a tank beside the orb at the same height', () => {
    expect(tankOrbConflict({ x: 1100, y: 816 }, orb, cfg)).toBe(true);
  });
  it('allows a tank straight above or below the orb when they are hundreds apart', () => {
    expect(tankOrbConflict({ x: 1000, y: 400 }, orb, cfg)).toBe(false); // several hundred above
    expect(tankOrbConflict({ x: 1000, y: 1300 }, orb, cfg)).toBe(false); // several hundred below
  });
  it('allows a tank well off to the side at the same height', () => {
    expect(tankOrbConflict({ x: 1400, y: 816 }, orb, cfg)).toBe(false);
  });
  it('agrees with the game: hovering where both are in reach really is possible when flagged', () => {
    // tank just below-right of the orb: hover over the tank, low, and the orb is within the rod
    expect(tankOrbConflict({ x: 1060, y: 900 }, orb, cfg)).toBe(true);
  });
});

describe('hostages belong to their rescue pad', () => {
  const lvl = () => {
    const d = structuredClone(newLevelTemplate());
    d.pads.push({ x: 1000, y: 790, w: 120, kind: 'rescue', guards: 1 }, { x: 2200, y: 790, w: 120, kind: 'rescue', guards: 0 });
    d.survivors = [
      { x: 1145, y: 800 },
      { x: 1165, y: 800 },
      { x: 2345, y: 800 },
    ];
    return d;
  };
  it('finds each pad\'s hostages', () => {
    const d = lvl();
    expect(padHostages(d, d.pads.length - 2)).toEqual([0, 1]);
    expect(padHostages(d, d.pads.length - 1)).toEqual([2]);
    expect(padHostages(d, 0)).toEqual([]); // the launch pad has none
  });
  it('flags hostages left with no rescue pad', () => {
    const d = lvl();
    expect(strayHostages(d)).toEqual([]);
    d.pads.splice(d.pads.length - 1, 1); // remove the second rescue pad only
    expect(strayHostages(d)).toEqual([{ x: 2345, y: 800 }]);
  });
});

describe('cutting a passage through rock', () => {
  // a 400-wide, 200-tall slab: cut straight down through its middle
  const slab = [0, 0, 400, 0, 400, 200, 0, 200];
  it('splits the shape in two with a gap of the chosen width', () => {
    const top = outlinePos(slab, 0, { x: 200, y: 0 });
    const bottom = outlinePos(slab, 2, { x: 200, y: 200 });
    const out = cutRock(slab, top, bottom, 100)!;
    expect(out).not.toBeNull();
    const xs = out.map((p) => p.filter((_, i) => i % 2 === 0));
    // one piece ends at x 150, the other starts at x 250: a 100-wide gap
    const right = xs.find((x) => Math.min(...x) >= 250)!;
    const left = xs.find((x) => Math.max(...x) <= 150)!;
    expect(Math.min(...right)).toBe(250);
    expect(Math.max(...left)).toBe(150);
  });
  it('refuses a cut too close to a corner for the width', () => {
    expect(cutRock(slab, outlinePos(slab, 0, { x: 30, y: 0 }), outlinePos(slab, 0, { x: 90, y: 0 }), 100)).toBeNull();
  });
  it('knows whether a cut line runs through rock or across open air', () => {
    const d = { ...newLevelTemplate(), terrain: [slab] };
    expect(cutsThroughRock(d, { x: 200, y: 0 }, { x: 200, y: 200 })).toBe(true);
    expect(cutsThroughRock(d, { x: 200, y: 0 }, { x: 600, y: 0 })).toBe(false);
  });
});
