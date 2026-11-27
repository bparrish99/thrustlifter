import type { Config } from '../config';
import type { LevelData } from '../level';
import { BOWL_HALF_W, BOWL_RIM_H, bowlSize } from '../level';
import { SURVIVOR_CALL_RANGE, TANK_H, TANK_REACH_X } from '../game';
import { distPointSegment, segmentIntersectionT, type Vec } from '../math';
import { ANCHOR } from '../physics';

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
    checkpoints: [{ x: 2300, y: 560, fuel: 40 }],
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
  for (const c of d.checkpoints ?? []) {
    if (!c.fuel) out.push({ level: 'error', text: 'A checkpoint needs a respawn fuel amount.', at: c });
    if (insideRock(d, c)) out.push({ level: 'error', text: 'A checkpoint is inside rock.', at: c });
    // you can respawn here carrying the orb, hanging on its rod below you: it needs room
    const g = groundBelow(d, c, 600);
    if (!insideRock(d, c) && g !== null && g - c.y < ANCHOR.y + cfg.rodLength + 16 + 12)
      out.push({ level: 'warn', text: 'A checkpoint is too close to the ground for the orb to hang below it (if you die carrying the orb).', at: c });
  }
  if (insideRock(d, d.orb)) out.push({ level: 'error', text: 'The orb is inside rock.', at: d.orb });
  const g = groundBelow(d, d.orb, 400);
  if (g === null || Math.abs(g - (d.orb.y + 16.5 + ORB_PEDESTAL_HEIGHT)) > 20)
    out.push({ level: 'warn', text: 'The orb pedestal isn’t standing on the ground (drag the orb to re-seat it).', at: d.orb });
  {
    const k = bowlSize(d.bowl);
    const rimY = d.bowl.y - BOWL_RIM_H * k - 6;
    if (insideRock(d, { x: d.bowl.x, y: rimY })) out.push({ level: 'error', text: 'The bowl is buried in rock.', at: d.bowl });
    else if ([-1, 1].some((side) => insideRock(d, { x: d.bowl.x + side * BOWL_HALF_W * k, y: rimY })))
      out.push({ level: 'warn', text: 'The bowl pokes into rock at one end (too big for that spot?).', at: d.bowl });
  }
  for (const p of d.pads) {
    if (insideRock(d, { x: p.x + p.w / 2, y: p.y - 30 })) out.push({ level: 'error', text: 'A pad is buried in rock.', at: { x: p.x + p.w / 2, y: p.y } });
  }
  for (const h of strayHostages(d)) out.push({ level: 'warn', text: 'Hostages with no rescue pad nearby (select them and press Del, or add a pad).', at: h });
  for (const t of d.fuelTanks ?? []) {
    if (tankOrbConflict(t, d.orb, cfg))
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

/**
 * Could you hover somewhere that has both a fuel tank and the orb in reach of Space at once?
 * Refuelling works from a box above the tank (within TANK_REACH_X sideways, up to tankReach above
 * its top); tethering works while the rod hook (ANCHOR, under the skids) is within rodLength of
 * the orb. They clash only if that box comes near the tether's reach (with a margin for tilt
 * swinging the hook sideways). Height counts: a tank far above or below the orb is fine.
 */
export function tankOrbConflict(t: { x: number; y: number }, orb: { x: number; y: number }, cfg: Pick<Config, 'rodLength' | 'tankReach'>): boolean {
  const top = t.y - TANK_H;
  // the heli positions that can refuel from this tank
  const box = { l: t.x - TANK_REACH_X, r: t.x + TANK_REACH_X, t: top - cfg.tankReach, b: top };
  // the heli positions that can tether the orb: a disc around the orb, offset by the hook
  const c = { x: orb.x - ANCHOR.x, y: orb.y - ANCHOR.y };
  const reach = cfg.rodLength + 40; // margin: tilt swings the hook, and you don't want them close anyway
  const nx = Math.max(box.l, Math.min(c.x, box.r));
  const ny = Math.max(box.t, Math.min(c.y, box.b));
  return Math.hypot(c.x - nx, c.y - ny) <= reach;
}

/**
 * The hostages that belong to rescue pad `padIndex`: those standing near it (the same "near" the game
 * uses to tie hostages to a pad's guards), and nearer this rescue pad than any other.
 */
export function padHostages(d: LevelData, padIndex: number): number[] {
  const pad = d.pads[padIndex];
  if (!pad || pad.kind !== 'rescue') return [];
  const out: number[] = [];
  (d.survivors ?? []).forEach((s, i) => {
    if (nearestRescuePad(d, s) === padIndex) out.push(i);
  });
  return out;
}

/** Index of the rescue pad a hostage belongs to, or -1 if none is near enough. */
function nearestRescuePad(d: LevelData, s: { x: number; y: number }): number {
  let best = -1;
  let bd = Infinity;
  d.pads.forEach((p, i) => {
    if (p.kind !== 'rescue') return;
    const dx = Math.abs(s.x - (p.x + p.w / 2));
    if (dx < SURVIVOR_CALL_RANGE + p.w && Math.abs(s.y - p.y) < 80 && dx < bd) {
      bd = dx;
      best = i;
    }
  });
  return best;
}

/** Hostages with no rescue pad near enough to land on and pick them up. */
export function strayHostages(d: LevelData): { x: number; y: number }[] {
  return (d.survivors ?? []).filter((s) => nearestRescuePad(d, s) < 0);
}

// ---------------------------------------------------------------- cutting a passage through rock

/** Positions along a rock shape's outline: each vertex's distance from vertex 0, and the total. */
function outline(poly: number[]): { pts: Vec[]; cum: number[]; total: number } {
  const pts: Vec[] = [];
  for (let k = 0; k < poly.length; k += 2) pts.push({ x: poly[k], y: poly[k + 1] });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const last = pts[pts.length - 1];
  const total = cum[cum.length - 1] + Math.hypot(pts[0].x - last.x, pts[0].y - last.y);
  return { pts, cum, total };
}

/** How far along the outline a point on edge `i` (from vertex i to vertex i+1) is. */
export function outlinePos(poly: number[], i: number, at: Vec): number {
  const { pts, cum } = outline(poly);
  return cum[i] + Math.hypot(at.x - pts[i].x, at.y - pts[i].y);
}

function outlinePoint(o: ReturnType<typeof outline>, s: number): Vec {
  const { pts, cum, total } = o;
  s = ((s % total) + total) % total;
  for (let i = 0; i < pts.length; i++) {
    const end = i + 1 < pts.length ? cum[i + 1] : total;
    if (s <= end) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const t = end > cum[i] ? (s - cum[i]) / (end - cum[i]) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return pts[0];
}

/**
 * Cut a passage `width` wide straight through a rock shape, between two points on its outline
 * (given as positions along it, see outlinePos). The shape becomes two shapes with a gap between
 * them: each keeps its own stretch of outline, stopping width/2 short of the cut points, and the
 * gap's walls run between those ends. Returns null if either stretch is too short to cut.
 */
export function cutRock(poly: number[], sa: number, sb: number, width: number): [number[], number[]] | null {
  const o = outline(poly);
  const fwd = (s0: number, s1: number) => (((s1 - s0) % o.total) + o.total) % o.total;
  const half = width / 2;
  if (fwd(sa, sb) < width + 20 || fwd(sb, sa) < width + 20) return null;
  const chain = (s0: number, s1: number): number[] => {
    const L = fwd(s0, s1);
    const mid = o.pts
      .map((p, k) => ({ p, d: fwd(s0, o.cum[k]) }))
      .filter((v) => v.d > 0.5 && v.d < L - 0.5)
      .sort((a, b) => a.d - b.d)
      .map((v) => v.p);
    return [outlinePoint(o, s0), ...mid, outlinePoint(o, s1)].flatMap((p) => [Math.round(p.x), Math.round(p.y)]);
  };
  const a = chain(sa + half, sb - half);
  const b = chain(sb + half, sa - half);
  if (a.length < 6 || b.length < 6) return null;
  return [a, b];
}

/** The stretch of outline from s0 forward to s1, as points (both ends included). */
function outlineChain(o: ReturnType<typeof outline>, s0: number, s1: number): Vec[] {
  const fwd = (a: number, b: number) => (((b - a) % o.total) + o.total) % o.total;
  const L = fwd(s0, s1);
  const mid = o.pts
    .map((p, k) => ({ p, d: fwd(s0, o.cum[k]) }))
    .filter((v) => v.d > 0.5 && v.d < L - 0.5)
    .sort((a, b) => a.d - b.d)
    .map((v) => v.p);
  return [outlinePoint(o, s0), ...mid, outlinePoint(o, s1)];
}

/**
 * Join tool: fill the open gap between two rock walls with solid rock. The new rock follows each
 * wall for `width` along its outline (centred on the clicked point) and spans the gap between, so
 * it sits flush against both walls; the game treats overlapping rock as one piece and hides the
 * seams. The walls can be on the same rock (closing a crack) or two different rocks.
 * Returns the new rock's outline, or null if a wall is too short for that width.
 */
export function joinFill(polyA: number[], sA: number, polyB: number[], sB: number, width: number): number[] | null {
  const oa = outline(polyA);
  const ob = outline(polyB);
  const h = width / 2;
  if (oa.total < width + 20 || ob.total < width + 20) return null;
  const a = outlineChain(oa, sA - h, sA + h);
  let b = outlineChain(ob, sB - h, sB + h);
  // facing walls usually run in opposite directions; if not (rocks drawn with opposite winding),
  // flip one so the filler's two crossing sides don't make a bow-tie
  if (segmentIntersectionT(a[a.length - 1], b[0], b[b.length - 1], a[0]) !== null) b = b.reverse();
  return [...a, ...b].flatMap((p) => [Math.round(p.x), Math.round(p.y)]);
}

/** Does the straight line between two points cross open air (so joining across it makes sense)? */
export function bridgesAir(d: LevelData, a: Vec, b: Vec): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 10) return false;
  const n = Math.max(2, Math.ceil(len / 10));
  let air = 0;
  let total = 0;
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (t * len < 8 || (1 - t) * len < 8) continue;
    total++;
    if (!insideRock(d, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) air++;
  }
  return total > 0 && air / total > 0.8;
}

/** Does the straight line between two points run entirely through rock (so cutting along it makes sense)? */
export function cutsThroughRock(d: LevelData, a: Vec, b: Vec): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(2, Math.ceil(len / 10));
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (t * len < 8 || (1 - t) * len < 8) continue; // the ends sit on the outline
    if (!insideRock(d, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
  }
  return true;
}
