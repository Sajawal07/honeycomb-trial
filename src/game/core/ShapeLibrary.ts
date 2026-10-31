import type { Vec } from './types';

/**
 * ShapeLibrary — additional hand-authored engraving outlines.
 * All coordinates are in normalized shape space (fit inside the unit circle,
 * y axis points down). Each builder returns one continuous outline; the
 * ShapeFactory resamples and validates it (continuity, bounds, clearance).
 */

interface Circle {
  x: number;
  y: number;
  r: number;
}

const PI = Math.PI;
const DEG = PI / 180;

function arc(out: Vec[], cx: number, cy: number, r: number, a0: number, a1: number): void {
  const steps = Math.max(6, Math.ceil((Math.abs(a1 - a0) * r) / 0.012));
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
}

/** Arc that always travels with decreasing angle (counter-clockwise on screen). */
function arcDec(out: Vec[], c: Circle, a0: number, a1: number): void {
  while (a1 > a0) a1 -= PI * 2;
  while (a1 < a0 - PI * 2) a1 += PI * 2;
  arc(out, c.x, c.y, c.r, a0, a1);
}

function quad(out: Vec[], p0: Vec, c: Vec, p1: Vec, steps = 28): void {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y });
  }
}

function cubic(out: Vec[], p0: Vec, c1: Vec, c2: Vec, p1: Vec, steps = 36): void {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push({ x: a * p0.x + b * c1.x + c * c2.x + d * p1.x, y: a * p0.y + b * c1.y + c * c2.y + d * p1.y });
  }
}

function poly(radius: number, sides: number, start: number, dy = 0): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < sides; i++) {
    const a = start + (i / sides) * PI * 2;
    pts.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius + dy });
  }
  return pts;
}

function verts(list: number[]): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < list.length; i += 2) pts.push({ x: list[i], y: list[i + 1] });
  return pts;
}

/** Right half (top axis point → bottom axis point) mirrored into a closed outline. */
function mirrorX(right: Vec[]): Vec[] {
  const left = right
    .slice(1, -1)
    .reverse()
    .map((p) => ({ x: -p.x, y: p.y }));
  return [...right, ...left];
}

function tf(pts: Vec[], o: { s?: number; dx?: number; dy?: number; rot?: number }): Vec[] {
  const s = o.s ?? 1;
  const c = Math.cos(o.rot ?? 0);
  const n = Math.sin(o.rot ?? 0);
  return pts.map((p) => ({ x: (p.x * c - p.y * n) * s + (o.dx ?? 0), y: (p.x * n + p.y * c) * s + (o.dy ?? 0) }));
}

function roundedRect(hw: number, hh: number, r: number): Vec[] {
  const pts: Vec[] = [];
  arc(pts, hw - r, -hh + r, r, -PI / 2, 0);
  arc(pts, hw - r, hh - r, r, 0, PI / 2);
  arc(pts, -hw + r, hh - r, r, PI / 2, PI);
  arc(pts, -hw + r, -hh + r, r, PI, PI * 1.5);
  return pts;
}

/** Intersection of two circles that lies farther from `ref` (the outer crease). */
function crease(a: Circle, b: Circle, ref: Vec): Vec {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const l = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - l * l));
  const mx = a.x + (dx * l) / d;
  const my = a.y + (dy * l) / d;
  const p1 = { x: mx - (dy * h) / d, y: my + (dx * h) / d };
  const p2 = { x: mx + (dy * h) / d, y: my - (dx * h) / d };
  return Math.hypot(p1.x - ref.x, p1.y - ref.y) > Math.hypot(p2.x - ref.x, p2.y - ref.y) ? p1 : p2;
}

const ang = (c: Circle, p: Vec) => Math.atan2(p.y - c.y, p.x - c.x);

/** Scalloped edge between two points on a horizontal line, bulging by `h` (negative = up). */
function scallop(out: Vec[], x0: number, x1: number, y: number, h: number): void {
  const half = Math.abs(x1 - x0) / 2;
  const depth = Math.abs(h);
  const r = (half * half + depth * depth) / (2 * depth);
  const xm = (x0 + x1) / 2;
  const cy = h > 0 ? y - (r - depth) : y + (r - depth);
  const a0 = Math.atan2(y - cy, x0 - xm);
  let a1 = Math.atan2(y - cy, x1 - xm);
  // Choose the short way that passes through the bulge.
  const mid = h > 0 ? PI / 2 : -PI / 2;
  const viaMid = (from: number, to: number) => {
    let t = to;
    while (t - from > PI) t -= PI * 2;
    while (from - t > PI) t += PI * 2;
    const lo = Math.min(from, t);
    const hi = Math.max(from, t);
    let m = mid;
    while (m < lo) m += PI * 2;
    while (m > hi + 1e-9) m -= PI * 2;
    return m >= lo && m <= hi ? t : t + (t > from ? -PI * 2 : PI * 2);
  };
  a1 = viaMid(a0, a1);
  arc(out, xm, cy, r, a0, a1);
}

export const SHAPE_BUILDERS: Record<string, () => Vec[]> = {
  square: () => roundedRect(0.64, 0.64, 0.15),

  hexagon: () => poly(0.88, 6, -PI / 2),

  moon: () => {
    const R = 0.86;
    const r2 = 0.62;
    const d = 0.5;
    const x = (R * R - r2 * r2 + d * d) / (2 * d);
    const y = Math.sqrt(R * R - x * x);
    const pts: Vec[] = [];
    const ao = Math.atan2(-y, x);
    arc(pts, 0, 0, R, ao, -PI * 2 - ao);
    const ai = Math.atan2(y, x - d);
    arc(pts, d, 0, r2, ai, PI * 2 - ai);
    pts.pop();
    return tf(pts, { dx: 0.06, rot: -0.35 });
  },

  cross: () => {
    const a = 0.25;
    const e = 0.8;
    return verts([-a, -e, a, -e, a, -a, e, -a, e, a, a, a, a, e, -a, e, -a, a, -e, a, -e, -a, -a, -a]);
  },

  arrow: () => verts([0, -0.92, 0.62, -0.22, 0.2, -0.22, 0.2, 0.88, -0.2, 0.88, -0.2, -0.22, -0.62, -0.22]),

  lightning: () => verts([-0.04, -0.86, 0.42, -0.86, 0.14, -0.14, 0.52, -0.14, -0.2, 0.88, -0.32, 0.88, -0.06, 0.06, -0.48, 0.06]),

  leaf: () => {
    const L = 0.9;
    const W = 0.4;
    const r = (L * L + W * W) / (2 * W);
    const c = r - W;
    const pts: Vec[] = [];
    arc(pts, 0, c, r, Math.atan2(-c, L), Math.atan2(-c, -L));
    arc(pts, 0, -c, r, Math.atan2(c, -L), Math.atan2(c, L));
    pts.pop();
    return tf(pts, { rot: -40 * DEG });
  },

  cloud: () => {
    const base = 0.38;
    const cs: Circle[] = [
      { x: 0.58, y: base - 0.24, r: 0.24 },
      { x: 0.24, y: -0.16, r: 0.34 },
      { x: -0.2, y: -0.2, r: 0.36 },
      { x: -0.56, y: base - 0.26, r: 0.26 },
    ];
    const ref = { x: 0, y: 0.1 };
    const pts: Vec[] = [];
    let start = PI / 2;
    for (let i = 0; i < cs.length; i++) {
      const end = i < cs.length - 1 ? ang(cs[i], crease(cs[i], cs[i + 1], ref)) : PI / 2;
      arcDec(pts, cs[i], start, end);
      if (i < cs.length - 1) start = ang(cs[i + 1], crease(cs[i], cs[i + 1], ref));
    }
    return tf(pts, { s: 1.1, dy: 0.1 });
  },

  house: () =>
    verts([0, -0.88, 0.74, -0.2, 0.54, -0.2, 0.54, 0.72, 0.14, 0.72, 0.14, 0.32, -0.14, 0.32, -0.14, 0.72, -0.54, 0.72, -0.54, -0.2, -0.74, -0.2]),

  fish: () => {
    const cx = -0.18;
    const a = 0.6;
    const b = 0.4;
    const pts: Vec[] = [
      { x: cx + a * Math.cos(-30 * DEG), y: b * Math.sin(-30 * DEG) },
      { x: 0.86, y: -0.46 },
      { x: 0.6, y: 0 },
      { x: 0.86, y: 0.46 },
    ];
    const steps = 160;
    for (let i = 0; i <= steps; i++) {
      const t = (30 + (300 * i) / steps) * DEG;
      pts.push({ x: cx + a * Math.cos(t), y: b * Math.sin(t) });
    }
    pts.pop();
    return pts;
  },

  bell: () => {
    const right: Vec[] = [];
    arc(right, 0, -0.78, 0.1, -PI / 2, 0);
    const domeA = -PI / 2 + Math.asin(0.1 / 0.4);
    arc(right, 0, -0.38, 0.4, domeA, 0);
    cubic(right, { x: 0.4, y: -0.38 }, { x: 0.42, y: 0.1 }, { x: 0.5, y: 0.42 }, { x: 0.74, y: 0.5 });
    right.push({ x: 0.74, y: 0.58 }, { x: 0.16, y: 0.58 });
    arc(right, 0, 0.58, 0.16, 0, PI / 2);
    return mirrorX(right);
  },

  clover: () => {
    const d = 0.42;
    const r = 0.4;
    const cs: Circle[] = [-45, -135, -225, -315].map((a) => ({ x: Math.cos(a * DEG) * d, y: Math.sin(a * DEG) * d, r }));
    const ref = { x: 0, y: 0 };
    const pts: Vec[] = [];
    for (let i = 0; i < 4; i++) {
      const prev = cs[(i + 3) % 4];
      const next = cs[(i + 1) % 4];
      arcDec(pts, cs[i], ang(cs[i], crease(prev, cs[i], ref)), ang(cs[i], crease(cs[i], next, ref)));
    }
    pts.pop();
    return pts;
  },

  raindrop: () => {
    const cy = 0.22;
    const r = 0.6;
    const tip = { x: 0, y: -0.9 };
    const d = cy - tip.y;
    const off = Math.acos(r / d);
    const pts: Vec[] = [tip];
    arc(pts, 0, cy, r, -PI / 2 + off, PI * 1.5 - off);
    return pts;
  },

  mushroom: () => {
    const pts: Vec[] = [];
    arc(pts, 0, -0.1, 0.84, PI, PI * 2);
    pts.push({ x: 0.28, y: 0.02 });
    cubic(pts, { x: 0.28, y: 0.02 }, { x: 0.26, y: 0.25 }, { x: 0.34, y: 0.45 }, { x: 0.32, y: 0.6 });
    for (let i = 1; i <= 40; i++) {
      const t = (i / 40) * PI;
      pts.push({ x: Math.cos(t) * 0.32, y: 0.6 + Math.sin(t) * 0.14 });
    }
    cubic(pts, { x: -0.32, y: 0.6 }, { x: -0.34, y: 0.45 }, { x: -0.26, y: 0.25 }, { x: -0.28, y: 0.02 });
    return pts;
  },

  tree: () =>
    mirrorX(verts([0, -0.92, 0.42, -0.44, 0.2, -0.44, 0.62, 0.06, 0.36, 0.06, 0.76, 0.52, 0.14, 0.52, 0.14, 0.82, 0, 0.82])),

  cat: () => {
    const c: Circle = { x: 0, y: 0.12, r: 0.68 };
    const p = (a: number) => ({ x: c.x + Math.cos(a * DEG) * c.r, y: c.y + Math.sin(a * DEG) * c.r });
    const pts: Vec[] = [];
    arc(pts, c.x, c.y, c.r, -100 * DEG, -80 * DEG);
    pts.push({ x: 0.52, y: -0.78 }, p(-25));
    arc(pts, c.x, c.y, c.r, -25 * DEG, 205 * DEG);
    pts.push({ x: -0.52, y: -0.78 });
    return pts;
  },

  crown: () => verts([-0.72, 0.56, 0.72, 0.56, 0.82, -0.48, 0.4, -0.04, 0, -0.7, -0.4, -0.04, -0.82, -0.48]),

  gear: () => {
    const ri = 0.62;
    const ro = 0.86;
    const pts: Vec[] = [];
    const at = (r: number, a: number) => ({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    for (let i = 0; i < 8; i++) {
      const c = -PI / 2 + (i * PI) / 4;
      pts.push(at(ri, c - 14 * DEG), at(ro, c - 9 * DEG), at(ro, c + 9 * DEG), at(ri, c + 14 * DEG));
      arc(pts, 0, 0, ri, c + 14 * DEG, c + 31 * DEG);
    }
    return pts;
  },

  ghost: () => {
    const pts: Vec[] = [];
    const w = 0.62;
    arc(pts, 0, -0.2, w, PI, PI * 2);
    pts.push({ x: w, y: 0.6 });
    const seg = (2 * w) / 3;
    for (let i = 0; i < 3; i++) scallop(pts, w - i * seg, w - (i + 1) * seg, 0.6, 0.15);
    return pts;
  },

  shield: () => {
    const right: Vec[] = [{ x: 0, y: -0.66 }];
    quad(right, { x: 0, y: -0.66 }, { x: 0.3, y: -0.72 }, { x: 0.56, y: -0.72 }, 16);
    arc(right, 0.56, -0.62, 0.1, -PI / 2, 0);
    right.push({ x: 0.66, y: -0.1 });
    quad(right, { x: 0.66, y: -0.1 }, { x: 0.62, y: 0.5 }, { x: 0, y: 0.9 });
    return mirrorX(right);
  },
};
