import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../config';
import { buildLevel, exposedEdges } from '../level';
import order from '../levels/order.json';
import { ALL_LEVEL_FILES, LEVELS, LEVEL_FILES, SHELVED_LEVEL_FILES, levelFile } from '../levels';
import { bridgesAir, joinFill, cutRock, cutsThroughRock, outlinePos, padHostages, strayHostages, tankOrbConflict, formatLevel, groundBelow, nearestSurface, newLevelTemplate, slugFile, snapToGround, tightSpots, validate } from './tools';

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

describe('joining rock across a gap', () => {
  // a block of rock with a 100-wide vertical crack down from its top edge (like LAYUP's)
  const crack = [0, 0, 400, 0, 400, 600, 450, 600, 450, 0, 1000, 0, 1000, 1000, 0, 1000];
  const level = (terrain: number[][]) => ({ ...newLevelTemplate(), terrain });
  const insideAny = (terrain: number[][], x: number, y: number) =>
    buildLevel(level(terrain)).polygons.some((pts) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i], b = pts[j];
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    });

  it('only a line across open air counts as a join', () => {
    expect(bridgesAir(level([crack]), { x: 400, y: 300 }, { x: 450, y: 300 })).toBe(true);
    expect(bridgesAir(level([crack]), { x: 0, y: 300 }, { x: 400, y: 300 })).toBe(false); // through rock
  });

  it('fills the crack flush against both walls', () => {
    // left wall runs 400,0 -> 400,600 (outline position 400..1000); right wall 450,600 -> 450,0
    const sA = outlinePos(crack, 1, { x: 400, y: 300 });
    const sB = outlinePos(crack, 3, { x: 450, y: 300 });
    const fill = joinFill(crack, sA, crack, sB, 200)!;
    expect(fill).not.toBeNull();
    const t = [crack, fill];
    expect(insideAny(t, 425, 300)).toBe(true); // crack filled where joined
    expect(insideAny(t, 425, 390)).toBe(true);
    expect(insideAny(t, 425, 100)).toBe(false); // the rest of the crack is still open
    expect(insideAny(t, 425, 550)).toBe(false);
  });

  it('seams where rocks meet are not drawn or collided with', () => {
    const sA = outlinePos(crack, 1, { x: 400, y: 300 });
    const sB = outlinePos(crack, 3, { x: 450, y: 300 });
    const fill = joinFill(crack, sA, crack, sB, 200)!;
    const lvl = buildLevel(level([crack, fill]));
    const touches = (x: number, y: number) => lvl.outline.some(([a, b]) => Math.min(a.x, b.x) - 1 <= x && x <= Math.max(a.x, b.x) + 1 && Math.min(a.y, b.y) - 1 <= y && y <= Math.max(a.y, b.y) + 1);
    expect(touches(400, 300)).toBe(false); // wall behind the filler: hidden
    expect(touches(450, 300)).toBe(false);
    expect(touches(400, 100)).toBe(true); // open crack wall: still a surface
    expect(lvl.segments.length).toBeGreaterThan(0);
  });

  it('overlapping rocks hide the edges buried inside each other; separate rocks keep every edge', () => {
    const sq = (x: number, y: number, w: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + w }, { x, y: y + w }];
    const apart = exposedEdges([sq(0, 0, 100), sq(300, 0, 100)]);
    expect(apart.length).toBe(8);
    const len = (es: ReturnType<typeof exposedEdges>) => es.reduce((t, [a, b]) => t + Math.hypot(b.x - a.x, b.y - a.y), 0);
    // two 100-squares overlapping by half: the union's perimeter is 600
    expect(len(exposedEdges([sq(0, 0, 100), sq(50, 0, 100)]))).toBeCloseTo(600, -1);
  });

});
