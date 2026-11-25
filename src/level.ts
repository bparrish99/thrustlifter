import type { Rect, Vec } from './math';

export interface PadData {
  x: number;
  y: number; // top surface
  w: number;
  kind: 'start' | 'drop';
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
  dropZone: Rect;
  targets: { x: number; y: number }[];
}

export interface Segment {
  a: Vec;
  b: Vec;
  /** Set when this edge is the landable top of a pad. */
  pad: PadData | null;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Level {
  data: LevelData;
  polygons: Vec[][];
  padPolygons: { pad: PadData; pts: Vec[] }[];
  segments: Segment[];
  startPad: PadData;
}

export const PAD_THICKNESS = 20;

function seg(a: Vec, b: Vec, pad: PadData | null): Segment {
  return {
    a,
    b,
    pad,
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

  const startPad = data.pads.find((p) => p.kind === 'start');
  if (!startPad) throw new Error(`Level "${data.name}" has no start pad`);

  return { data, polygons, padPolygons, segments, startPad };
}

/** Segments whose bounding box overlaps the given box. */
export function segmentsNear(level: Level, minX: number, minY: number, maxX: number, maxY: number): Segment[] {
  const out: Segment[] = [];
  for (const s of level.segments) {
    if (s.maxX >= minX && s.minX <= maxX && s.maxY >= minY && s.minY <= maxY) out.push(s);
  }
  return out;
}
