import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../config';
import { buildLevel } from '../level';
import order from '../levels/order.json';
import { ALL_LEVEL_FILES, LEVELS, LEVEL_FILES, SHELVED_LEVEL_FILES, levelFile } from '../levels';
import { formatLevel, groundBelow, nearestSurface, newLevelTemplate, slugFile, snapToGround, tightSpots, validate } from './tools';

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
