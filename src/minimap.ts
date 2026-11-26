import type { LevelData } from './level';

/** World rectangle the minimap shows. */
export interface MapBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The part of a level worth mapping: its full width, and vertically from a little above the highest
 * thing you'd fly near down to the deepest floor. Levels are sealed with far-off rock borders
 * (e.g. walls up to y=-1200, a floor slab at y=1400); those extreme values are ignored so the
 * map isn't mostly solid rock.
 */
export function minimapBounds(d: LevelData): MapBounds {
  const ys = d.terrain.flatMap((poly) => poly.filter((_, i) => i % 2 === 1));
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const inner = ys.filter((y) => y > top && y < bottom);
  const things: number[] = [
    ...d.pads.map((p) => p.y),
    d.orb.y,
    d.bowl.y,
    ...(d.turrets ?? []).map((t) => t.y),
    ...(d.balloons ?? []).map((b) => b.y),
    ...(d.fuelTanks ?? []).map((t) => t.y),
    ...(d.survivors ?? []).map((s) => s.y),
    ...(d.checkpoints ?? []).map((c) => c.y),
  ];
  const y0 = Math.min(...things) - 350; // sky above the highest object: room to climb
  const y1 = Math.max(...inner, ...things) + 60; // the deepest floor
  return { x0: 0, y0: Math.max(top, y0), x1: d.width, y1: Math.min(bottom, y1) };
}
