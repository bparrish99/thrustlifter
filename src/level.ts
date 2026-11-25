import type { Vec } from './math';

export interface PadData {
  x: number;
  y: number; // top surface
  w: number;
  kind: 'start';
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
  targets: { x: number; y: number }[];
}

export interface Segment {
  a: Vec;
  b: Vec;
  /** Set when this edge is the landable top of a pad. */
  pad: PadData | null;
  /** Part of the orb bowl (orb contact here is a set-down attempt, not an instant crash). */
  bowl: boolean;
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

export interface Level {
  data: LevelData;
  bowl: Bowl;
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

  return { data, bowl, polygons, padPolygons, segments, startPad };
}

/** Segments whose bounding box overlaps the given box. */
export function segmentsNear(level: Level, minX: number, minY: number, maxX: number, maxY: number): Segment[] {
  const out: Segment[] = [];
  for (const s of level.segments) {
    if (s.maxX >= minX && s.minX <= maxX && s.maxY >= minY && s.minY <= maxY) out.push(s);
  }
  return out;
}
