import { SHAPE_BUILDERS } from './ShapeLibrary';
import type { ShapeId, Vec } from './types';

/**
 * ShapeFactory
 * Every shape is authored in a normalized space where the shape fits inside
 * the unit circle (|p| <= 1). The renderer scales it to the cookie size.
 * Raw outlines are resampled to uniform arc-length spacing so the tracing
 * engine can measure coverage per contour point.
 */

export interface Contour {
  id: ShapeId;
  name: string;
  closed: boolean;
  complexity: number;
  points: Vec[];
  normals: Vec[];
  length: number;
  spacing: number;
}

export interface ShapeMeta {
  id: ShapeId;
  name: string;
  complexity: number;
  closed: boolean;
}

/** All engraving designs, ordered by complexity (unlock order). */
export const SHAPES: ShapeMeta[] = [
  { id: 'circle', name: 'Circle', complexity: 1.0, closed: true },
  { id: 'square', name: 'Square', complexity: 1.05, closed: true },
  { id: 'hexagon', name: 'Hexagon', complexity: 1.15, closed: true },
  { id: 'diamond', name: 'Diamond', complexity: 1.2, closed: true },
  { id: 'triangle', name: 'Triangle', complexity: 1.3, closed: true },
  { id: 'raindrop', name: 'Raindrop', complexity: 1.35, closed: true },
  { id: 'leaf', name: 'Leaf', complexity: 1.4, closed: true },
  { id: 'shield', name: 'Shield', complexity: 1.45, closed: true },
  { id: 'moon', name: 'Crescent Moon', complexity: 1.55, closed: true },
  { id: 'heart', name: 'Heart', complexity: 1.6, closed: true },
  { id: 'cross', name: 'Cross', complexity: 1.65, closed: true },
  { id: 'arrow', name: 'Arrow', complexity: 1.7, closed: true },
  { id: 'house', name: 'House', complexity: 1.85, closed: true },
  { id: 'mushroom', name: 'Mushroom', complexity: 1.9, closed: true },
  { id: 'crown', name: 'Crown', complexity: 1.95, closed: true },
  { id: 'star', name: 'Star', complexity: 2.0, closed: true },
  { id: 'ghost', name: 'Ghost', complexity: 2.05, closed: true },
  { id: 'cat', name: 'Cat', complexity: 2.1, closed: true },
  { id: 'fish', name: 'Fish', complexity: 2.15, closed: true },
  { id: 'flower', name: 'Flower', complexity: 2.2, closed: true },
  { id: 'bell', name: 'Bell', complexity: 2.25, closed: true },
  { id: 'clover', name: 'Clover', complexity: 2.3, closed: true },
  { id: 'cloud', name: 'Cloud', complexity: 2.35, closed: true },
  { id: 'spiral', name: 'Spiral', complexity: 2.4, closed: false },
  { id: 'lightning', name: 'Lightning', complexity: 2.5, closed: true },
  { id: 'tree', name: 'Pine Tree', complexity: 2.6, closed: true },
  { id: 'umbrella', name: 'Umbrella', complexity: 2.65, closed: true },
  { id: 'gear', name: 'Gear', complexity: 2.8, closed: true },
];

export const SHAPE_IDS: ReadonlySet<string> = new Set(SHAPES.map((s) => s.id));

export const CONTOUR_SPACING = 0.01;

function arc(out: Vec[], cx: number, cy: number, r: number, a0: number, a1: number, steps = 48): void {
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
}

function polygon(radius: number, sides: number, startAngle: number, dy = 0): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < sides; i++) {
    const a = startAngle + (i / sides) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius + dy });
  }
  return pts;
}

function rawShape(id: ShapeId): Vec[] {
  switch (id) {
    case 'circle':
      return polygon(0.82, 180, -Math.PI / 2);
    case 'triangle':
      return polygon(0.86, 3, -Math.PI / 2, 0.2);
    case 'diamond':
      return [
        { x: 0, y: -0.94 },
        { x: 0.66, y: 0 },
        { x: 0, y: 0.94 },
        { x: -0.66, y: 0 },
      ];
    case 'star': {
      const pts: Vec[] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 0.94 : 0.43;
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r + 0.04 });
      }
      return pts;
    }
    case 'flower': {
      const pts: Vec[] = [];
      const n = 360;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        const r = 0.7 + 0.22 * Math.cos(6 * t);
        pts.push({ x: Math.cos(t - Math.PI / 2) * r, y: Math.sin(t - Math.PI / 2) * r });
      }
      return pts;
    }
    case 'heart': {
      // Two circular lobes joined by tangent lines to the bottom tip.
      const pts: Vec[] = [];
      const lr = 0.46;
      const lcx = 0.4;
      const lcy = -0.34;
      const tip = { x: 0, y: 0.86 };
      const cuspDy = Math.sqrt(lr * lr - lcx * lcx);
      const cuspAngleR = Math.atan2(lcy - cuspDy - lcy, -lcx); // angle of cusp from right lobe center
      const dx = tip.x - lcx;
      const dy = tip.y - lcy;
      const d = Math.hypot(dx, dy);
      const base = Math.atan2(dy, dx);
      const off = Math.acos(lr / d);
      const tanR = base - off; // outer tangent on the right lobe
      arc(pts, lcx, lcy, lr, cuspAngleR, tanR, 90);
      pts.push({ ...tip });
      const tanL = Math.PI - tanR;
      const cuspAngleL = Math.PI - cuspAngleR;
      arc(pts, -lcx, lcy, lr, tanL, cuspAngleL, 90);
      pts.pop(); // last equals the cusp (first point)
      return pts;
    }
    case 'umbrella': {
      const pts: Vec[] = [];
      const R = 0.84;
      const sx = 0.09; // shaft half width
      const yb = 0.08; // canopy rim baseline
      const flare = 0.25; // canopy extends slightly below its equator
      const ccy = yb - R * Math.sin(flare);
      const ex = R * Math.cos(flare);
      // Canopy from left rim over the top to the right rim.
      arc(pts, 0, ccy, R, Math.PI - flare, Math.PI * 2 + flare, 120);
      // Scalloped rim: shallow arcs bulging upward.
      const scallop = (xr: number, xl: number, h: number) => {
        const c = xr - xl;
        const rr = (c * c * 0.25 + h * h) / (2 * h);
        const xm = (xr + xl) / 2;
        const cyc = yb + rr - h;
        const a0 = Math.atan2(yb - cyc, xr - xm);
        const a1 = Math.atan2(yb - cyc, xl - xm);
        // Go from right endpoint over the top (decreasing angle).
        arc(pts, xm, cyc, rr, a0, a1 - Math.PI * 2 * (a1 > a0 ? 1 : 0), 30);
      };
      const w = (ex - sx) / 2;
      scallop(ex, ex - w, 0.11);
      scallop(ex - w, sx, 0.11);
      const cy = yb;
      // Shaft down the right side.
      const hookY = 0.56;
      pts.push({ x: sx, y: hookY });
      // Hook.
      const rIn = 0.1;
      const hcx = -sx - rIn;
      const rOut = sx - hcx;
      arc(pts, hcx, hookY, rOut, 0, Math.PI, 60);
      const capR = (rOut - rIn) / 2;
      const capX = hcx - (rIn + rOut) / 2;
      arc(pts, capX, hookY, capR, Math.PI, Math.PI * 2, 20);
      arc(pts, hcx, hookY, rIn, Math.PI, 0, 30);
      // Shaft up the left side.
      pts.push({ x: -sx, y: cy });
      scallop(-sx, -sx - w, 0.11);
      scallop(-sx - w, -ex, 0.11);
      // Remove duplicate closing point (equals canopy start).
      pts.pop();
      return pts;
    }
    case 'spiral': {
      const pts: Vec[] = [];
      const turns = 2;
      const r0 = 0.12;
      const r1 = 0.9;
      const tMax = turns * Math.PI * 2;
      const b = (r1 - r0) / tMax;
      const n = 600;
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * tMax;
        const r = r0 + b * t;
        pts.push({ x: Math.cos(t - Math.PI / 2) * r, y: Math.sin(t - Math.PI / 2) * r + 0.02 });
      }
      return pts;
    }
    default: {
      const build = SHAPE_BUILDERS[id];
      if (!build) throw new Error(`Unknown shape: ${id}`);
      return build();
    }
  }
}

/** Resample a polyline to uniform arc length spacing. */
export function resample(raw: Vec[], spacing: number, closed: boolean): { points: Vec[]; length: number } {
  // Remove consecutive duplicates.
  const src: Vec[] = [];
  for (const p of raw) {
    const last = src[src.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) src.push(p);
  }
  if (closed) {
    const f = src[0];
    const l = src[src.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) src.pop();
    src.push({ ...src[0] });
  }
  const cum: number[] = [0];
  for (let i = 1; i < src.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(src[i].x - src[i - 1].x, src[i].y - src[i - 1].y));
  }
  const length = cum[cum.length - 1];
  const n = Math.max(16, Math.round(length / spacing));
  const count = closed ? n : n + 1;
  const points: Vec[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / n) * length;
    while (seg < src.length - 2 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg] || 1;
    const t = Math.min(1, Math.max(0, (target - cum[seg]) / segLen));
    points.push({
      x: src[seg].x + (src[seg + 1].x - src[seg].x) * t,
      y: src[seg].y + (src[seg + 1].y - src[seg].y) * t,
    });
  }
  return { points, length };
}

function computeNormals(points: Vec[], closed: boolean): Vec[] {
  const n = points.length;
  const normals: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const l = Math.hypot(tx, ty) || 1;
    normals.push({ x: -ty / l, y: tx / l });
  }
  return normals;
}

export interface ValidationResult {
  ok: boolean;
  issues: string[];
  minClearance: number;
}

/**
 * Validates contour: finite points, inside unit circle, continuous (no gaps),
 * closed shapes return to start, and distinct contour sections are separated
 * enough that tracing corridors do not merge.
 */
export function validateContour(c: Contour, minClearance = 0.16): ValidationResult {
  const issues: string[] = [];
  const pts = c.points;
  const n = pts.length;
  if (n < 32) issues.push(`too few points (${n})`);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      issues.push(`non-finite point at ${i}`);
      break;
    }
    if (Math.hypot(p.x, p.y) > 1.0001) {
      issues.push(`point ${i} outside unit circle (${Math.hypot(p.x, p.y).toFixed(3)})`);
      break;
    }
  }
  const segCount = c.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > c.spacing * 1.6) {
      issues.push(`discontinuity between ${i} and ${(i + 1) % n} (${d.toFixed(4)})`);
      break;
    }
  }
  // Clearance between sections far apart along the path.
  const arcSep = 0.6;
  const idxSep = Math.ceil(arcSep / c.spacing);
  let clearance = Infinity;
  for (let i = 0; i < n; i += 2) {
    for (let j = i + idxSep; j < n; j += 2) {
      let along = j - i;
      if (c.closed) along = Math.min(along, n - along);
      if (along < idxSep) continue;
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d < clearance) clearance = d;
    }
  }
  if (clearance < minClearance) issues.push(`sections too close (${clearance.toFixed(3)})`);
  return { ok: issues.length === 0, issues, minClearance: clearance };
}

const cache = new Map<ShapeId, Contour>();

export function getContour(id: ShapeId): Contour {
  const hit = cache.get(id);
  if (hit) return hit;
  const meta = SHAPES.find((s) => s.id === id) ?? SHAPES[0];
  const { points, length } = resample(rawShape(meta.id), CONTOUR_SPACING, meta.closed);
  const contour: Contour = {
    id: meta.id,
    name: meta.name,
    closed: meta.closed,
    complexity: meta.complexity,
    points,
    normals: computeNormals(points, meta.closed),
    length,
    spacing: length / (meta.closed ? points.length : points.length - 1),
  };
  cache.set(id, contour);
  return contour;
}

/** Builds a Path2D-compatible point list scaled to screen space. */
export function tracePath(ctx: CanvasRenderingContext2D | Path2D, c: Contour, cx: number, cy: number, s: number): void {
  const p = c.points;
  ctx.moveTo(cx + p[0].x * s, cy + p[0].y * s);
  for (let i = 1; i < p.length; i++) ctx.lineTo(cx + p[i].x * s, cy + p[i].y * s);
  if (c.closed) ctx.closePath();
}
