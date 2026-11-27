import type { Vec } from './math';

export interface PadData {
  x: number;
  y: number; // top surface
  w: number;
  /** start = launch/return pad; rescue = where survivors wait. Each pad gives a one-time fuel boost. */
  kind: 'start' | 'rescue';
  /** How many enemy helicopters guard this pad (they launch one at a time when you come near; none come once its hostages are picked up). 0/absent = unguarded. */
  guards?: number;
  /** Guards stay parked (asleep) until this happens, e.g. so none attack during the orb carry. */
  guardsAfter?: 'delivery';
}

/** Plain-JSON level format (hand-authored now, editor-authored later). */
export interface LevelData {
  name: string;
  width: number;
  /** Solid rock polygons, each a flat [x0,y0,x1,y1,...] list. */
  terrain: number[][];
  pads: PadData[];
  /** Orb resting centre. */
  orb: { x: number; y: number };
  /** Orb bowl: centre x, and the ground y it sits on. `size` scales it evenly (1 = standard, the
   *  default; 2 = twice as wide, deep and tall), for levels where you lob the orb in from a distance. */
  bowl: { x: number; y: number; size?: number };
  /** Energy barriers. `opens: 'delivery'` starts closed and opens when the orb is delivered;
   *  `closes: 'pickup'` starts open and seals when you first grab the orb; `closes: 'delivery'`
   *  starts open and seals when the orb is delivered. A sealing gate waits until you're clear of it. */
  gates?: { poly: number[]; opens?: 'delivery'; closes?: 'pickup' | 'delivery' }[];
  /** Enemy balloons: drift around (x,y) within `patrol` (default from config) and shoot at you. */
  balloons?: { x: number; y: number; patrol?: number }[];
  /** Fuel tanks sitting on the ground at (x,y): hover over one and hold Space to suck it up. Shootable. */
  fuelTanks?: { x: number; y: number; amount?: number }[];
  /** Little people to rescue (optional bonus): feet at (x,y) on the ground, near a pad. */
  survivors?: { x: number; y: number }[];
  /** Invisible respawn points. When you die you come back at whichever respawn point (these, or the
   *  launch pad) is closest to where you died, by flying distance; at a checkpoint you hover, held
   *  until you touch the controls. `fuel` tops you up to that minimum there (no soft-locks).
   *  (`after: 'delivery'` is a leftover from when there was one after-delivery checkpoint; it's ignored.)
   *  If a level has none, a point above the bowl is used. */
  checkpoints?: { x: number; y: number; fuel?: number; after?: 'delivery' }[];
  /** Target time in seconds: finishing under it earns POINTS.perTenthUnderTarget per tenth of a second. */
  targetTime?: number;
  /** Minimum fuel when you respawn on the launch pad. `checkpoints[].fuel` is the same for each
   *  checkpoint. Size these so the next stretch is always possible: no soft-locks. */
  startFuelMin?: number;
  /** Below this y, empty space shows a dark cave backdrop instead of sky. */
  backdropY?: number;
  /** Turrets sit at (x,y) on any surface and align to it automatically (floor, slope, wall, ceiling, pad top).
   *  dir (degrees, -90 = up) is only a hint for which side of a thin surface they're on. */
  turrets: { x: number; y: number; dir?: number }[];
}

export interface Segment {
  a: Vec;
  b: Vec;
  /** Set when this edge is the landable top of a pad. */
  pad: PadData | null;
  /** Part of the orb bowl (orb contact here is a set-down attempt, not an instant crash). */
  bowl: boolean;
  /** Index into level.gates when this edge belongs to a gate (solid only while that gate is closed). */
  gate?: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Bowl {
  cx: number;
  rimY: number;
  innerR: number;
  /** Half the outside width. */
  halfW: number;
  /** Where the orb's centre ends up once it settles in the cup. */
  rest: Vec;
  pts: Vec[];
}

export interface Gate {
  pts: Vec[];
  opens?: 'delivery';
  closes?: 'pickup' | 'delivery';
  open: boolean;
  /** Due to seal, waiting for the heli and orb to be clear of it. */
  sealPending?: boolean;
  /** Visual 0 = fully solid .. 1 = fully gone (animated by the game). */
  fade: number;
}

export interface Level {
  data: LevelData;
  bowl: Bowl;
  /** Pedestal the orb starts on (outline, solid). */
  pedestal: Vec[];
  gates: Gate[];
  /** Deepest terrain y (for camera limits). */
  maxY: number;
  polygons: Vec[][];
  /** The rock's visible surface: polygon edges minus the parts buried inside other rock. */
  outline: [Vec, Vec][];
  padPolygons: { pad: PadData; pts: Vec[] }[];
  segments: Segment[];
  startPad: PadData;
}

export const PAD_THICKNESS = 20;
// at size 1:
export const BOWL_INNER_R = 28; // cup radius; orb radius is 16, so you have ~±12 of slop
export const BOWL_HALF_W = 40;
export const BOWL_RIM_H = 34; // rim height above the ground
export const BOWL_MIN_SIZE = 1;
export const BOWL_MAX_SIZE = 5;

/** A bowl's size multiplier, clamped to the allowed range. */
export function bowlSize(b: { size?: number }): number {
  return Math.min(BOWL_MAX_SIZE, Math.max(BOWL_MIN_SIZE, b.size ?? 1));
}

/** A solid block with a semicircular cup cut into its top. */
function buildBowl(x: number, y: number, size = 1, orbRadius = 16): Bowl {
  const innerR = BOWL_INNER_R * size;
  const halfW = BOWL_HALF_W * size;
  const rimY = y - BOWL_RIM_H * size;
  const base = y + 10 * size; // sunk into the ground, deeper for a big bowl on a slope
  // the rim tops slope down into the cup, so an orb that bounces up onto one rolls in rather than
  // balancing there (the orb can't break on the bowl, so it can arrive fast and bounce high)
  const lip = rimY - 10 * size;
  const pts: Vec[] = [
    { x: x - halfW, y: base },
    { x: x - halfW, y: lip },
  ];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const t = Math.PI - (i / N) * Math.PI; // left rim, down through the bottom, up to right rim
    pts.push({ x: x + Math.cos(t) * innerR, y: rimY + Math.sin(t) * innerR });
  }
  pts.push({ x: x + halfW, y: lip }, { x: x + halfW, y: base });
  return { cx: x, rimY, innerR, halfW, rest: { x, y: rimY + innerR - orbRadius }, pts };
}

function seg(a: Vec, b: Vec, pad: PadData | null, bowl = false): Segment {
  return {
    a,
    b,
    pad,
    bowl,
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
  };
}

function insidePoly(p: Vec, pts: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Rock edges that face open air. A stretch of edge with rock on both sides (inside another rock, or
 * where two rocks meet flush) is dropped. Edges nowhere near another rock are kept whole without testing.
 */
export function exposedEdges(polygons: Vec[][]): [Vec, Vec][] {
  const box = polygons.map((pts) => ({
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxY: Math.max(...pts.map((p) => p.y)),
  }));
  const rockAt = (p: Vec, cands: number[]) => cands.some((k) => p.x >= box[k].minX && p.x <= box[k].maxX && p.y >= box[k].minY && p.y <= box[k].maxY && insidePoly(p, polygons[k]));
  const out: [Vec, Vec][] = [];
  polygons.forEach((pts, pi) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const pad = 3;
      const others = box
        .map((_, k) => k)
        .filter((k) => k !== pi && Math.max(a.x, b.x) + pad >= box[k].minX && Math.min(a.x, b.x) - pad <= box[k].maxX && Math.max(a.y, b.y) + pad >= box[k].minY && Math.min(a.y, b.y) - pad <= box[k].maxY);
      if (!others.length) {
        out.push([a, b]);
        continue;
      }
      // test short pieces: hidden if there's rock just to either side of it
      const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
      const pieces = Math.max(1, Math.ceil(len / 6));
      const all = [pi, ...others];
      let runStart: number | null = null;
      for (let k = 0; k <= pieces; k++) {
        let exposed = false;
        if (k < pieces) {
          const t = (k + 0.5) / pieces;
          const m = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          const l = rockAt({ x: m.x + n.x * 1.5, y: m.y + n.y * 1.5 }, all);
          const r = rockAt({ x: m.x - n.x * 1.5, y: m.y - n.y * 1.5 }, all);
          exposed = !(l && r);
        }
        if (exposed && runStart === null) runStart = k;
        if (!exposed && runStart !== null) {
          const t0 = runStart / pieces;
          const t1 = k / pieces;
          out.push([
            { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 },
            { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
          ]);
          runStart = null;
        }
      }
    }
  });
  return out;
}

export function buildLevel(data: LevelData): Level {
  const polygons = data.terrain.map((flat) => {
    const pts: Vec[] = [];
    for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
    return pts;
  });

  // only the rock's real surface collides and gets drawn: edges buried inside other rock (where
  // rocks overlap, e.g. a Join filling a gap) are left out, so overlapping rocks act as one piece
  const outline = exposedEdges(polygons);
  const segments: Segment[] = outline.map(([a, b]) => seg(a, b, null));

  const padPolygons = data.pads.map((pad) => {
    const pts: Vec[] = [
      { x: pad.x, y: pad.y },
      { x: pad.x + pad.w, y: pad.y },
      { x: pad.x + pad.w, y: pad.y + PAD_THICKNESS },
      { x: pad.x, y: pad.y + PAD_THICKNESS },
    ];
    segments.push(seg(pts[0], pts[1], pad)); // landable top
    segments.push(seg(pts[1], pts[2], null));
    segments.push(seg(pts[3], pts[0], null));
    return { pad, pts };
  });

  // orb pedestal: a tapered plinth whose cradle top sits just under the orb's start; its foot is
  // buried in the ground, so levels only place the orb, not the pedestal
  const o = data.orb;
  const top = o.y + 16.5;
  const pedestal: Vec[] = [
    { x: o.x - 22, y: top + 70 },
    { x: o.x - 16, y: top + 10 },
    { x: o.x - 24, y: top + 4 },
    { x: o.x - 24, y: top },
    { x: o.x - 8, y: top },
    { x: o.x - 5, y: top + 3 },
    { x: o.x + 5, y: top + 3 },
    { x: o.x + 8, y: top },
    { x: o.x + 24, y: top },
    { x: o.x + 24, y: top + 4 },
    { x: o.x + 16, y: top + 10 },
    { x: o.x + 22, y: top + 70 },
  ];
  for (let i = 0; i < pedestal.length; i++) segments.push(seg(pedestal[i], pedestal[(i + 1) % pedestal.length], null));
  const bowl = buildBowl(data.bowl.x, data.bowl.y, bowlSize(data.bowl));
  for (let i = 0; i < bowl.pts.length; i++) segments.push(seg(bowl.pts[i], bowl.pts[(i + 1) % bowl.pts.length], null, true));

  const startPad = data.pads.find((p) => p.kind === 'start');
  if (!startPad) throw new Error(`Level "${data.name}" has no start pad`);

  const gates: Gate[] = (data.gates ?? []).map((g, gi) => {
    const pts: Vec[] = [];
    for (let i = 0; i < g.poly.length; i += 2) pts.push({ x: g.poly[i], y: g.poly[i + 1] });
    for (let i = 0; i < pts.length; i++) {
      const sg = seg(pts[i], pts[(i + 1) % pts.length], null);
      sg.gate = gi;
      segments.push(sg);
    }
    const open = !!g.closes;
    return { pts, opens: g.opens, closes: g.closes, open, fade: open ? 1 : 0 };
  });

  const maxY = polygons.length ? Math.max(...polygons.flat().map((p) => p.y)) : data.bowl.y + 200; // (no rock: a blank editor canvas)
  return { data, bowl, pedestal, gates, maxY, polygons, outline, padPolygons, segments, startPad };
}

/** Put every gate back to its starting state. */
export function resetGates(level: Level): void {
  for (const g of level.gates) {
    g.open = !!g.closes;
    g.fade = g.open ? 1 : 0;
    g.sealPending = false;
  }
}

/** Segments whose bounding box overlaps the given box. */
export function segmentsNear(level: Level, minX: number, minY: number, maxX: number, maxY: number): Segment[] {
  const out: Segment[] = [];
  for (const s of level.segments) {
    if (s.gate !== undefined && level.gates[s.gate].open) continue;
    if (s.maxX >= minX && s.minX <= maxX && s.maxY >= minY && s.minY <= maxY) out.push(s);
  }
  return out;
}
