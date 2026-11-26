import type { Vec } from './math';

export interface PadData {
  x: number;
  y: number; // top surface
  w: number;
  /** start = launch/return pad; rescue = where survivors wait. Each pad gives a one-time fuel boost. */
  kind: 'start' | 'rescue';
  /** Enemy helicopters guarding this pad (launch one at a time when you come near). */
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
  /** Orb bowl: centre x, and the ground y it sits on. */
  bowl: { x: number; y: number };
  /** Energy barriers. `opens: 'delivery'` starts closed and opens when the orb is delivered;
   *  `closes: 'pickup'` starts open and seals when you first grab the orb. */
  gates?: { poly: number[]; opens?: 'delivery'; closes?: 'pickup' }[];
  /** Enemy balloons: drift around (x,y) within `patrol` (default from config) and shoot at you. */
  balloons?: { x: number; y: number; patrol?: number }[];
  /** Fuel tanks sitting on the ground at (x,y): hover over one and hold Space to suck it up. Shootable. */
  fuelTanks?: { x: number; y: number; amount?: number }[];
  /** Little people to rescue (optional bonus): feet at (x,y) on the ground, near a pad. */
  survivors?: { x: number; y: number }[];
  /** Invisible respawn points (heli reappears hovering, held until you touch the controls).
   *  `after: 'delivery'` applies once the orb is delivered. If a level has none, the game
   *  uses a point above the bowl. */
  checkpoints?: { x: number; y: number; after: 'delivery'; fuel?: number }[];
  /** Minimum fuel when you respawn on the launch pad (before delivery). `checkpoints[].fuel` is the
   *  same for each checkpoint. Size these so the next stretch is always possible: no soft-locks. */
  startFuelMin?: number;
  /** Below this y, empty space shows a dark cave backdrop instead of sky. */
  backdropY?: number;
  /** Turrets sit at (x,y) on a surface. dir = direction they face in degrees (-90 = up, 90 = hanging from a ceiling). */
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
  /** Where the orb's centre ends up once it settles in the cup. */
  rest: Vec;
  pts: Vec[];
}

export interface Gate {
  pts: Vec[];
  opens?: 'delivery';
  closes?: 'pickup';
  open: boolean;
  /** Visual 0 = fully solid .. 1 = fully gone (animated by the game). */
  fade: number;
}

export interface Level {
  data: LevelData;
  bowl: Bowl;
  gates: Gate[];
  /** Deepest terrain y (for camera limits). */
  maxY: number;
  polygons: Vec[][];
  padPolygons: { pad: PadData; pts: Vec[] }[];
  segments: Segment[];
  startPad: PadData;
}

export const PAD_THICKNESS = 20;
export const BOWL_INNER_R = 28; // cup radius; orb radius is 16, so you have ~±12 of slop
export const BOWL_HALF_W = 40;
export const BOWL_RIM_H = 34; // rim height above the ground

/** A solid block with a semicircular cup cut into its top. */
function buildBowl(x: number, y: number, orbRadius = 16): Bowl {
  const rimY = y - BOWL_RIM_H;
  const pts: Vec[] = [
    { x: x - BOWL_HALF_W, y: y + 10 },
    { x: x - BOWL_HALF_W, y: rimY },
  ];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const t = Math.PI - (i / N) * Math.PI; // left rim, down through the bottom, up to right rim
    pts.push({ x: x + Math.cos(t) * BOWL_INNER_R, y: rimY + Math.sin(t) * BOWL_INNER_R });
  }
  pts.push({ x: x + BOWL_HALF_W, y: rimY }, { x: x + BOWL_HALF_W, y: y + 10 });
  return { cx: x, rimY, innerR: BOWL_INNER_R, rest: { x, y: rimY + BOWL_INNER_R - orbRadius }, pts };
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

export function buildLevel(data: LevelData): Level {
  const polygons = data.terrain.map((flat) => {
    const pts: Vec[] = [];
    for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
    return pts;
  });

  const segments: Segment[] = [];
  for (const pts of polygons) {
    for (let i = 0; i < pts.length; i++) segments.push(seg(pts[i], pts[(i + 1) % pts.length], null));
  }

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

  const bowl = buildBowl(data.bowl.x, data.bowl.y);
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

  const maxY = Math.max(...polygons.flat().map((p) => p.y));
  return { data, bowl, gates, maxY, polygons, padPolygons, segments, startPad };
}

/** Put every gate back to its starting state. */
export function resetGates(level: Level): void {
  for (const g of level.gates) {
    g.open = !!g.closes;
    g.fade = g.open ? 1 : 0;
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
