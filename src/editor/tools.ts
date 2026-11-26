import type { Config } from '../config';
import type { LevelData } from '../level';
import { distPointSegment, segmentIntersectionT, type Vec } from '../math';

/** Plain terrain edges (no pads/bowl/gates), for snapping things onto the ground. */
export function terrainEdges(d: LevelData): [Vec, Vec][] {
  const out: [Vec, Vec][] = [];
  for (const flat of d.terrain) {
    const n = flat.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      out.push([
        { x: flat[i * 2], y: flat[i * 2 + 1] },
        { x: flat[j * 2], y: flat[j * 2 + 1] },
      ]);
    }
  }
  return out;
}

/** y of the first terrain surface straight below `from` (within maxDist), or null. */
export function groundBelow(d: LevelData, from: Vec, maxDist = 3000): number | null {
  const to = { x: from.x, y: from.y + maxDist };
  let best: number | null = null;
  for (const [a, b] of terrainEdges(d)) {
    const t = segmentIntersectionT(from, to, a, b);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best === null ? null : from.y + best * maxDist;
}

export function pointInPolygonFlat(p: Vec, flat: number[]): boolean {
  let inside = false;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = flat[i * 2];
    const ay = flat[i * 2 + 1];
    const bx = flat[j * 2];
    const by = flat[j * 2 + 1];
    if (ay > p.y !== by > p.y && p.x < ((bx - ax) * (p.y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

export function insideRock(d: LevelData, p: Vec): boolean {
  return d.terrain.some((poly) => pointInPolygonFlat(p, poly));
}

/**
 * Snap a point onto the ground beneath it. If the point is inside rock, search upward first
 * so dragging slightly into the ground still lands on top of it.
 */
export function snapToGround(d: LevelData, p: Vec): number | null {
  const start = insideRock(d, p) ? { x: p.x, y: p.y - 400 } : { x: p.x, y: p.y - 2 };
  return groundBelow(d, start);
}

/** Nearest terrain surface point to p, with the outward normal (pointing into open space). */
export function nearestSurface(d: LevelData, p: Vec, maxDist = 120): { pos: Vec; normal: Vec } | null {
  let best: { pos: Vec; normal: Vec; d: number } | null = null;
  // pad tops count as surfaces too
  const padTops: [Vec, Vec][] = d.pads.map((pd) => [{ x: pd.x + pd.w, y: pd.y }, { x: pd.x, y: pd.y }]);
  for (const [a, b] of [...terrainEdges(d), ...padTops]) {
    const dd = distPointSegment(p, a, b);
    if (dd > maxDist || (best && dd >= best.d)) continue;
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const l2 = ab.x * ab.x + ab.y * ab.y;
    if (l2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2));
    const pos = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const L = Math.sqrt(l2);
    let n = { x: -ab.y / L, y: ab.x / L };
    const solid = (q: Vec) => insideRock(d, q) || d.pads.some((pd) => q.x >= pd.x && q.x <= pd.x + pd.w && q.y >= pd.y && q.y <= pd.y + 20);
    if (solid({ x: pos.x + n.x * 4, y: pos.y + n.y * 4 })) n = { x: -n.x, y: -n.y };
    best = { pos, normal: n, d: dd };
  }
  return best ? { pos: best.pos, normal: best.normal } : null;
}

export const ORB_PEDESTAL_HEIGHT = 38; // pedestal top sits this far above the ground
export const PAD_EMBED = 10; // pads sink this far into the ground

/** Level data template for "New level": flat ground between two walls, with the essentials placed. */
export function newLevelTemplate(): LevelData {
  return {
    name: 'NEW LEVEL',
    width: 3000,
    targetTime: 120,
    startFuelMin: 50,
    checkpoints: [{ x: 2300, y: 560, after: 'delivery', fuel: 40 }],
    terrain: [[0, 1400, 0, -1200, 120, -1200, 140, 800, 2860, 800, 2880, -1200, 3000, -1200, 3000, 1400]],
    pads: [{ x: 220, y: 800 - PAD_EMBED, w: 160, kind: 'start' }],
    orb: { x: 1300, y: 800 - ORB_PEDESTAL_HEIGHT - 16.5 },
    bowl: { x: 2300, y: 800 },
    turrets: [],
  };
}

export interface Problem {
  level: 'error' | 'warn';
  text: string;
  at?: Vec;
}

/** Things that would make a level broken or unfair. Errors stop it being playable/saved. */
export function validate(d: LevelData, cfg: Config): Problem[] {
  const out: Problem[] = [];
  const starts = d.pads.filter((p) => p.kind === 'start');
  if (starts.length === 0) out.push({ level: 'error', text: 'No launch pad (place one with the Pad tool).' });
  if (starts.length > 1) out.push({ level: 'warn', text: 'More than one launch pad: only the first is used.' });
  if (!d.name.trim()) out.push({ level: 'error', text: 'Level needs a name.' });
  if (!(d.width > 400)) out.push({ level: 'error', text: 'Level width is too small.' });
  if (!(d.targetTime && d.targetTime > 0)) out.push({ level: 'warn', text: 'No target time (no time bonus).' });
  if (!(d.startFuelMin && d.startFuelMin > 0)) out.push({ level: 'error', text: 'Set a minimum fuel for respawning at the launch pad.' });
  const cp = d.checkpoints?.find((c) => c.after === 'delivery');
  if (!cp?.fuel) out.push({ level: 'error', text: 'Place an after-delivery checkpoint and give it a minimum fuel.' });
  if (insideRock(d, d.orb)) out.push({ level: 'error', text: 'The orb is inside rock.', at: d.orb });
  const g = groundBelow(d, d.orb, 400);
  if (g === null || Math.abs(g - (d.orb.y + 16.5 + ORB_PEDESTAL_HEIGHT)) > 20)
    out.push({ level: 'warn', text: 'The orb pedestal isn’t standing on the ground (drag the orb to re-seat it).', at: d.orb });
  if (insideRock(d, { x: d.bowl.x, y: d.bowl.y - 40 })) out.push({ level: 'error', text: 'The bowl is buried in rock.', at: d.bowl });
  for (const p of d.pads) {
    if (insideRock(d, { x: p.x + p.w / 2, y: p.y - 30 })) out.push({ level: 'error', text: 'A pad is buried in rock.', at: { x: p.x + p.w / 2, y: p.y } });
  }
  for (const t of d.fuelTanks ?? []) {
    if (Math.abs(t.x - d.orb.x) <= cfg.rodLength + 45 + 40)
      out.push({ level: 'error', text: 'A fuel tank is so close to the orb that Space would grab both.', at: t });
  }
  for (const t of d.turrets) {
    const a = ((t.dir ?? -90) * Math.PI) / 180;
    if (insideRock(d, { x: t.x + Math.cos(a) * 20, y: t.y + Math.sin(a) * 20 })) out.push({ level: 'warn', text: 'A turret is facing into rock.', at: t });
  }
  return out;
}

/** Level JSON with terrain written as one "x, y" pair per line, so the files stay readable. */
export function formatLevel(d: LevelData): string {
  const copy = { ...d, terrain: d.terrain.map((_, i) => `@@T${i}@@`) };
  let s = JSON.stringify(copy, null, 2);
  d.terrain.forEach((poly, i) => {
    const pairs: string[] = [];
    for (let k = 0; k < poly.length; k += 2) pairs.push(`${round(poly[k])}, ${round(poly[k + 1])}`);
    s = s.replace(`"@@T${i}@@"`, `[\n      ${pairs.join(',\n      ')}\n    ]`);
  });
  return s + '\n';
}

const round = (v: number) => Math.round(v * 10) / 10;

export function slugFile(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'level'}.json`;
}

/**
 * Cramped passages, measured by casting rays from sample points in open space:
 * - 'tight' (red): a gap (floor to ceiling, or wall to wall) too small for the heli at all.
 * - 'snug' (amber): the heli fits, but floor-to-ceiling is too low for the orb hanging below it.
 * Only enclosed spots (both rays hit something nearby) are reported, so open sky stays clean.
 */
export function tightSpots(d: LevelData, heli: number, withOrb: number, step = 25): { p: Vec; level: 'tight' | 'snug' }[] {
  const edges = terrainEdges(d);
  const maxY = Math.max(...d.terrain.flat().filter((_, i) => i % 2 === 1));
  const reach = Math.max(withOrb, heli) + 40;
  const ray = (p: Vec, dx: number, dy: number): number => {
    const to = { x: p.x + dx * reach, y: p.y + dy * reach };
    let best = Infinity;
    for (const [a, b] of edges) {
      if (Math.max(a.x, b.x) < Math.min(p.x, to.x) || Math.min(a.x, b.x) > Math.max(p.x, to.x)) continue;
      if (Math.max(a.y, b.y) < Math.min(p.y, to.y) || Math.min(a.y, b.y) > Math.max(p.y, to.y)) continue;
      const t = segmentIntersectionT(p, to, a, b);
      if (t !== null) best = Math.min(best, t * reach);
    }
    return best;
  };
  const out: { p: Vec; level: 'tight' | 'snug' }[] = [];
  for (let y = -600; y < maxY; y += step) {
    for (let x = step / 2; x < d.width; x += step) {
      const p = { x, y };
      if (insideRock(d, p)) continue;
      const vgap = ray(p, 0, -1) + ray(p, 0, 1);
      const hgap = ray(p, -1, 0) + ray(p, 1, 0);
      if (vgap < heli || hgap < heli) out.push({ p, level: 'tight' });
      else if (vgap < withOrb) out.push({ p, level: 'snug' });
    }
  }
  return out;
}
