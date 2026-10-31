import type { Crack, CrackSimulator } from '../core/CrackSimulator';
import { mulberry32 } from '../core/rng';
import { tracePath, type Contour } from '../core/ShapeFactory';
import type { TraceTracker } from '../core/TraceController';
import type { Vec } from '../core/types';
import { clamp } from '../core/types';
import { ParticleSystem } from './ParticleSystem';

export type RenderPhase = 'idle' | 'intro' | 'playing' | 'success' | 'breaking' | 'timeout';

export interface NeedleState {
  x: number;
  y: number;
  down: boolean;
  visible: boolean;
  onPath: boolean;
  strain: number;
}

export interface FrameState {
  dt: number;
  time: number;
  phase: RenderPhase;
  phaseT: number;
  contour: Contour | null;
  tracker: TraceTracker | null;
  cracks: CrackSimulator | null;
  needle: NeedleState;
  shake: number;
}

export interface Layout {
  w: number;
  h: number;
  dpr: number;
  cx: number;
  cy: number;
  R: number;
  scale: number;
  k: number;
}

interface BreakPiece {
  poly: Vec[]; // relative to cookie center (screen px)
  dir: number;
  speed: number;
  spin: number;
  cx: number;
  cy: number;
}

export const SHAPE_SCALE = 0.74;

/** Bake variants: each round's cookie gets one, chosen deterministically from its seed. */
export interface Bake {
  name: string;
  side: [string, string];
  face: [string, string, string, string];
  tint: string;
}

export const BAKES: Bake[] = [
  { name: 'Golden', side: ['#8a4c16', '#4e2a0c'], face: ['#f2bd62', '#de9a38', '#c47c24', '#9c5818'], tint: '#d58a2c' },
  { name: 'Honey', side: ['#946018', '#573509'], face: ['#f8d27a', '#e9b44c', '#d0922e', '#a8681c'], tint: '#e0a23a' },
  { name: 'Amber', side: ['#7c3c10', '#43200a'], face: ['#e8a24e', '#d0812c', '#b2661c', '#874414'], tint: '#c47224' },
  { name: 'Toasted', side: ['#6a3410', '#381a07'], face: ['#d99446', '#bf7428', '#9e5a1a', '#733a10'], tint: '#a85f20' },
];

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

/**
 * CanvasRenderer
 * Layered 2.5D rendering. Expensive layers (table, plate, cookie texture with
 * engraving) are cached to offscreen canvases and rebuilt only on resize or a
 * new round. Trace and crack overlays are cached and redrawn only when their
 * simulation revision changes.
 */
export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  layout: Layout = { w: 1, h: 1, dpr: 1, cx: 0, cy: 0, R: 100, scale: 74, k: 1 };
  effects: 'high' | 'low' = 'high';
  readonly particles: ParticleSystem;

  private noiseTile: HTMLCanvasElement;
  private bg: HTMLCanvasElement | null = null;
  private plate: HTMLCanvasElement | null = null;
  private cookie: HTMLCanvasElement | null = null;
  private traceLayer: HTMLCanvasElement | null = null;
  private crackLayer: HTMLCanvasElement | null = null;
  private cacheSize = 0; // CSS px size of square caches
  private contour: Contour | null = null;
  private seed = 1;
  private traceRev = -1;
  private crackRev = -1;
  private crackAnimUntil = 0;
  private shapePath: Path2D | null = null;
  private pieces: BreakPiece[] = [];
  private needlePos: Vec = { x: 0, y: 0 };
  private needleLift = 1;
  private needleInit = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
    this.particles = new ParticleSystem();
    this.noiseTile = this.makeNoiseTile(128);
  }

  setEffects(level: 'high' | 'low'): void {
    if (this.effects === level) return;
    this.effects = level;
    this.particles.max = level === 'high' ? 160 : 60;
    this.resize(this.layout.w, this.layout.h);
  }

  resize(w: number, h: number): void {
    const dprCap = this.effects === 'high' ? 2 : 1.5;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const topReserve = Math.min(170, h * 0.2);
    const bottomReserve = Math.min(84, h * 0.09);
    const avail = Math.max(120, h - topReserve - bottomReserve);
    const R = Math.max(60, Math.min((w / 2 - 10) / 1.17, (avail / 2) / 1.17, 270));
    const cy = topReserve + avail / 2;
    this.layout = { w, h, dpr, cx: w / 2, cy, R, scale: R * SHAPE_SCALE, k: clamp(R / 150, 0.8, 1.9) };
    this.bg = null;
    this.plate = null;
    this.cookie = null;
    this.traceLayer = null;
    this.crackLayer = null;
    this.traceRev = -1;
    this.crackRev = -1;
    if (this.contour) this.buildCookie();
    this.buildShapePath();
  }

  toNormalized(x: number, y: number): Vec {
    const L = this.layout;
    return { x: (x - L.cx) / L.scale, y: (y - L.cy) / L.scale };
  }

  toScreen(v: Vec): Vec {
    const L = this.layout;
    return { x: L.cx + v.x * L.scale, y: L.cy + v.y * L.scale };
  }

  prepareRound(contour: Contour, seed: number): void {
    this.contour = contour;
    this.seed = seed;
    this.pieces = [];
    this.traceRev = -1;
    this.crackRev = -1;
    this.crackAnimUntil = 0;
    this.cookie = null;
    this.buildCookie();
    this.buildShapePath();
    this.particles.clear();
  }

  private buildShapePath(): void {
    if (!this.contour) return;
    const L = this.layout;
    const p = new Path2D();
    tracePath(p, this.contour, L.cx, L.cy, L.scale);
    this.shapePath = p;
  }

  // ---------------------------------------------------------------- caches

  private makeNoiseTile(size: number): HTMLCanvasElement {
    const c = makeCanvas(size, size);
    const g = c.getContext('2d')!;
    const img = g.createImageData(size, size);
    const rnd = mulberry32(777);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(rnd() * 255);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  private buildBackground(): void {
    const L = this.layout;
    const c = makeCanvas(L.w * L.dpr, L.h * L.dpr);
    const g = c.getContext('2d')!;
    g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    const base = g.createLinearGradient(0, 0, 0, L.h);
    base.addColorStop(0, '#1d1815');
    base.addColorStop(0.5, '#15110f');
    base.addColorStop(1, '#0b0908');
    g.fillStyle = base;
    g.fillRect(0, 0, L.w, L.h);
    // Warm overhead spotlight.
    const spot = g.createRadialGradient(L.cx, L.cy - L.R * 0.3, L.R * 0.2, L.cx, L.cy, Math.max(L.w, L.h) * 0.75);
    spot.addColorStop(0, 'rgba(255,170,90,0.16)');
    spot.addColorStop(0.45, 'rgba(200,120,60,0.06)');
    spot.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = spot;
    g.fillRect(0, 0, L.w, L.h);
    // Subtle linen weave.
    g.globalAlpha = 0.035;
    g.strokeStyle = '#d8b48a';
    g.lineWidth = 1;
    for (let y = 0; y < L.h; y += 3) {
      g.beginPath();
      g.moveTo(0, y + 0.5);
      g.lineTo(L.w, y + 0.5);
      g.stroke();
    }
    g.globalAlpha = 1;
    // Grain.
    const pat = g.createPattern(this.noiseTile, 'repeat');
    if (pat) {
      g.globalAlpha = 0.05;
      g.globalCompositeOperation = 'overlay';
      g.fillStyle = pat;
      g.fillRect(0, 0, L.w, L.h);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    // Vignette.
    const vig = g.createRadialGradient(L.cx, L.cy, Math.min(L.w, L.h) * 0.35, L.cx, L.cy, Math.max(L.w, L.h) * 0.8);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = vig;
    g.fillRect(0, 0, L.w, L.h);
    this.bg = c;
  }

  private newCache(): { c: HTMLCanvasElement; g: CanvasRenderingContext2D; C: number } {
    const L = this.layout;
    const size = Math.ceil(L.R * 2.7);
    this.cacheSize = size;
    const c = makeCanvas(size * L.dpr, size * L.dpr);
    const g = c.getContext('2d')!;
    g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    return { c, g, C: size / 2 };
  }

  private buildPlate(): void {
    const L = this.layout;
    const { c, g, C } = this.newCache();
    const R = L.R;
    const Rp = R * 1.16;
    // Table shadow under the tin.
    const sh = g.createRadialGradient(C + R * 0.05, C + R * 0.12, Rp * 0.7, C + R * 0.05, C + R * 0.12, Rp * 1.12);
    sh.addColorStop(0, 'rgba(0,0,0,0.6)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sh;
    g.beginPath();
    g.arc(C + R * 0.05, C + R * 0.12, Rp * 1.12, 0, Math.PI * 2);
    g.fill();
    // Tin body.
    const body = g.createRadialGradient(C - Rp * 0.35, C - Rp * 0.45, Rp * 0.1, C, C, Rp);
    body.addColorStop(0, '#6a645c');
    body.addColorStop(0.55, '#38332f');
    body.addColorStop(1, '#1b1816');
    g.fillStyle = body;
    g.beginPath();
    g.arc(C, C, Rp, 0, Math.PI * 2);
    g.fill();
    // Brushed concentric marks.
    const rnd = mulberry32(31);
    g.lineWidth = 0.6;
    for (let r = Rp * 0.94; r > R * 0.2; r -= 1.6) {
      g.strokeStyle = `rgba(255,240,220,${(0.015 + rnd() * 0.03).toFixed(3)})`;
      g.beginPath();
      g.arc(C, C, r, 0, Math.PI * 2);
      g.stroke();
    }
    // Rim bevel.
    const rim = g.createLinearGradient(C - Rp, C - Rp, C + Rp, C + Rp);
    rim.addColorStop(0, 'rgba(235,225,205,0.75)');
    rim.addColorStop(0.45, 'rgba(120,110,100,0.35)');
    rim.addColorStop(1, 'rgba(10,8,6,0.9)');
    g.strokeStyle = rim;
    g.lineWidth = R * 0.045;
    g.beginPath();
    g.arc(C, C, Rp - R * 0.0225, 0, Math.PI * 2);
    g.stroke();
    // Inner well shadow.
    const well = g.createLinearGradient(C - Rp, C - Rp, C + Rp, C + Rp);
    well.addColorStop(0, 'rgba(0,0,0,0.55)');
    well.addColorStop(1, 'rgba(255,240,220,0.12)');
    g.strokeStyle = well;
    g.lineWidth = R * 0.02;
    g.beginPath();
    g.arc(C, C, Rp - R * 0.06, 0, Math.PI * 2);
    g.stroke();
    this.plate = c;
  }

  private buildCookie(): void {
    if (!this.contour) return;
    const L = this.layout;
    if (!this.plate) this.buildPlate();
    const { c, g, C } = this.newCache();
    const R = L.R;
    const k = L.k;
    const rnd = mulberry32(this.seed ^ 0x9e3779b9);
    const bake = BAKES[(this.seed >>> 3) % BAKES.length];

    // Contact shadow + side thickness (2.5D depth).
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.65)';
    g.shadowBlur = R * 0.1;
    g.shadowOffsetX = R * 0.02;
    g.shadowOffsetY = R * 0.06;
    const side = g.createLinearGradient(0, C - R, 0, C + R);
    side.addColorStop(0, bake.side[0]);
    side.addColorStop(1, bake.side[1]);
    g.fillStyle = side;
    g.beginPath();
    g.arc(C, C + R * 0.045, R, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // Top face.
    const face = g.createRadialGradient(C - R * 0.28, C - R * 0.32, R * 0.05, C, C, R * 1.05);
    face.addColorStop(0, bake.face[0]);
    face.addColorStop(0.42, bake.face[1]);
    face.addColorStop(0.8, bake.face[2]);
    face.addColorStop(1, bake.face[3]);
    g.fillStyle = face;
    g.beginPath();
    g.arc(C, C, R, 0, Math.PI * 2);
    g.fill();

    g.save();
    g.beginPath();
    g.arc(C, C, R, 0, Math.PI * 2);
    g.clip();

    // Low-frequency caramelization mottling.
    g.imageSmoothingEnabled = true;
    g.globalCompositeOperation = 'soft-light';
    g.globalAlpha = 0.5;
    const ox = rnd() * 64;
    const oy = rnd() * 64;
    g.drawImage(this.noiseTile, ox, oy, 24, 24, C - R, C - R, R * 2, R * 2);
    g.globalAlpha = 0.35;
    g.drawImage(this.noiseTile, ox + 20, oy + 10, 60, 60, C - R, C - R, R * 2, R * 2);
    // Warm caramel re-tint so the mottling stays golden, never grey.
    g.globalCompositeOperation = 'color';
    g.globalAlpha = 0.35;
    g.fillStyle = bake.tint;
    g.fillRect(C - R, C - R, R * 2, R * 2);
    // Fine sugar grain.
    g.globalCompositeOperation = 'overlay';
    g.globalAlpha = 0.16;
    const pat = g.createPattern(this.noiseTile, 'repeat');
    if (pat) {
      g.fillStyle = pat;
      g.fillRect(C - R, C - R, R * 2, R * 2);
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;

    // Edge browning.
    const edge = g.createRadialGradient(C, C, R * 0.7, C, C, R);
    edge.addColorStop(0, 'rgba(110,52,8,0)');
    edge.addColorStop(1, 'rgba(100,46,6,0.55)');
    g.fillStyle = edge;
    g.fillRect(C - R, C - R, R * 2, R * 2);

    // Honeycomb air bubbles (cavities lit from top-left).
    const bubbles = Math.round(90 + R * 0.25);
    for (let i = 0; i < bubbles; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * R * 0.95;
      const x = C + Math.cos(a) * rr;
      const y = C + Math.sin(a) * rr;
      const s = R * (0.006 + Math.pow(rnd(), 3) * 0.032);
      const ry = s * (0.75 + rnd() * 0.25);
      g.fillStyle = 'rgba(120,60,12,0.38)';
      g.beginPath();
      g.ellipse(x, y, s, ry, a, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(64,28,4,0.32)';
      g.beginPath();
      g.ellipse(x - s * 0.2, y - s * 0.22, s * 0.7, ry * 0.65, a, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,228,170,0.4)';
      g.lineWidth = Math.max(0.5, s * 0.25);
      g.beginPath();
      g.ellipse(x, y, s, ry, a, -0.1, Math.PI * 0.75);
      g.stroke();
    }
    // Tiny raised sugar crystals.
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * R * 0.95;
      const x = C + Math.cos(a) * rr;
      const y = C + Math.sin(a) * rr;
      g.fillStyle = 'rgba(255,236,190,0.35)';
      g.fillRect(x, y, 0.9, 0.9);
    }

    // Engraved outline (groove with lit lower lip).
    const path = new Path2D();
    tracePath(path, this.contour, C, C, L.scale);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.save();
    g.translate(0.8 * k, 1.1 * k);
    g.strokeStyle = 'rgba(255,224,168,0.55)';
    g.lineWidth = 3.4 * k;
    g.stroke(path);
    g.restore();
    g.strokeStyle = 'rgba(96,46,10,0.82)';
    g.lineWidth = 3.0 * k;
    g.stroke(path);
    g.save();
    g.translate(-0.35 * k, -0.45 * k);
    g.strokeStyle = 'rgba(44,19,3,0.65)';
    g.lineWidth = 1.2 * k;
    g.stroke(path);
    g.restore();

    // Glossy sugar sheen.
    g.globalCompositeOperation = 'screen';
    const sheen = g.createRadialGradient(C - R * 0.38, C - R * 0.42, 0, C - R * 0.38, C - R * 0.42, R * 0.95);
    sheen.addColorStop(0, 'rgba(255,240,205,0.32)');
    sheen.addColorStop(1, 'rgba(255,240,205,0)');
    g.fillStyle = sheen;
    g.fillRect(C - R, C - R, R * 2, R * 2);
    g.globalCompositeOperation = 'source-over';
    g.restore();

    // Bevelled rim.
    const bevel = g.createLinearGradient(C - R, C - R, C + R, C + R);
    bevel.addColorStop(0, 'rgba(255,232,185,0.6)');
    bevel.addColorStop(0.5, 'rgba(200,130,50,0.1)');
    bevel.addColorStop(1, 'rgba(60,24,4,0.65)');
    g.strokeStyle = bevel;
    g.lineWidth = 3 * k;
    g.beginPath();
    g.arc(C, C, R - 1.5 * k, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(58,26,6,0.85)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(C, C, R, 0, Math.PI * 2);
    g.stroke();

    this.cookie = c;
    const t = makeCanvas(c.width, c.height);
    this.traceLayer = t;
    const cr = makeCanvas(c.width, c.height);
    this.crackLayer = cr;
    this.traceRev = -1;
    this.crackRev = -1;
  }

  private updateTraceLayer(tracker: TraceTracker | null): void {
    if (!this.traceLayer || !tracker || tracker.revision === this.traceRev) return;
    this.traceRev = tracker.revision;
    const L = this.layout;
    const g = this.traceLayer.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.traceLayer.width, this.traceLayer.height);
    g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    const C = this.cacheSize / 2;
    const pts = tracker.contour.points;
    const n = pts.length;
    const v = tracker.visited;
    const path = new Path2D();
    const segs = tracker.contour.closed ? n : n - 1;
    let open = false;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      if (v[i] && v[j]) {
        if (!open) {
          path.moveTo(C + pts[i].x * L.scale, C + pts[i].y * L.scale);
          open = true;
        }
        path.lineTo(C + pts[j].x * L.scale, C + pts[j].y * L.scale);
      } else open = false;
    }
    const k = L.k;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.save();
    g.translate(0.6 * k, 0.9 * k);
    g.strokeStyle = 'rgba(255,226,170,0.6)';
    g.lineWidth = 2.6 * k;
    g.stroke(path);
    g.restore();
    g.strokeStyle = 'rgba(36,15,2,0.95)';
    g.lineWidth = 1.8 * k;
    g.stroke(path);
    g.strokeStyle = 'rgba(255,196,110,0.22)';
    g.lineWidth = 0.6 * k;
    g.stroke(path);
  }

  private updateCrackLayer(cracks: CrackSimulator | null, force = false): void {
    if (!this.crackLayer || !cracks) return;
    const animating = cracks.time < this.crackAnimUntil || cracks.latestBorn > cracks.time - 0.02;
    if (!force && cracks.revision === this.crackRev && !animating) return;
    this.crackRev = cracks.revision;
    this.crackAnimUntil = cracks.latestBorn + 0.05;
    const L = this.layout;
    const g = this.crackLayer.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.crackLayer.width, this.crackLayer.height);
    g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    const C = this.cacheSize / 2;
    const s = L.scale;
    const k = L.k;
    const now = force ? Infinity : cracks.time;
    g.lineCap = 'round';
    for (const crack of cracks.cracks) this.drawCrack(g, crack, C, s, k, now);
  }

  private drawCrack(g: CanvasRenderingContext2D, crack: Crack, C: number, s: number, k: number, now: number): void {
    // Chipped zone at origin.
    const o = crack.segments[0];
    if (o && now >= o.born) {
      const rg = g.createRadialGradient(C + o.x1 * s, C + o.y1 * s, 0, C + o.x1 * s, C + o.y1 * s, 9 * k);
      rg.addColorStop(0, 'rgba(60,26,4,0.35)');
      rg.addColorStop(1, 'rgba(60,26,4,0)');
      g.fillStyle = rg;
      g.fillRect(C + o.x1 * s - 9 * k, C + o.y1 * s - 9 * k, 18 * k, 18 * k);
    }
    for (const seg of crack.segments) {
      if (now < seg.born) continue;
      const f = clamp((now - seg.born) / 0.05, 0, 1);
      const x1 = C + seg.x1 * s;
      const y1 = C + seg.y1 * s;
      const x2 = x1 + (seg.x2 - seg.x1) * s * f;
      const y2 = y1 + (seg.y2 - seg.y1) * s * f;
      const w = seg.width * k * 0.85;
      g.strokeStyle = `rgba(255,214,160,${(0.38 - seg.gen * 0.08).toFixed(2)})`;
      g.lineWidth = w * 0.7;
      g.beginPath();
      g.moveTo(x1 + 0.7 * k, y1 + 0.9 * k);
      g.lineTo(x2 + 0.7 * k, y2 + 0.9 * k);
      g.stroke();
      g.strokeStyle = `rgba(${34 + seg.gen * 14},${14 + seg.gen * 8},2,${(0.92 - seg.gen * 0.18).toFixed(2)})`;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
  }

  // ---------------------------------------------------------------- effects

  /** Creates broken pieces radiating from the last stress point. */
  startBreak(originNorm: Vec, seed: number): void {
    const L = this.layout;
    const R = L.R;
    const rnd = mulberry32(seed);
    let ox = originNorm.x * L.scale;
    let oy = originNorm.y * L.scale;
    const d = Math.hypot(ox, oy);
    if (d > R * 0.55) {
      ox = (ox / d) * R * 0.55;
      oy = (oy / d) * R * 0.55;
    }
    const count = 7;
    const angles: number[] = [];
    const base = rnd() * Math.PI * 2;
    for (let i = 0; i < count; i++) angles.push(base + (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.5);
    const rays: Vec[][] = angles.map((a) => {
      const pts: Vec[] = [{ x: ox, y: oy }];
      const steps = 5;
      for (let s = 1; s <= steps; s++) {
        const r = (R * 1.6 * s) / steps;
        const j = s < steps ? (rnd() - 0.5) * 0.35 : 0;
        pts.push({ x: ox + Math.cos(a + j) * r, y: oy + Math.sin(a + j) * r });
      }
      return pts;
    });
    this.pieces = [];
    for (let i = 0; i < count; i++) {
      const a0 = angles[i];
      const a1 = angles[(i + 1) % count] + (i === count - 1 ? Math.PI * 2 : 0);
      const poly: Vec[] = [...rays[i]];
      const arcSteps = 8;
      for (let s = 1; s < arcSteps; s++) {
        const a = a0 + ((a1 - a0) * s) / arcSteps;
        poly.push({ x: ox + Math.cos(a) * R * 1.6, y: oy + Math.sin(a) * R * 1.6 });
      }
      poly.push(...[...rays[(i + 1) % count]].reverse());
      const mid = (a0 + a1) / 2;
      this.pieces.push({
        poly,
        dir: mid,
        speed: R * (0.18 + rnd() * 0.22),
        spin: (rnd() - 0.5) * 0.9,
        cx: ox + Math.cos(mid) * R * 0.5,
        cy: oy + Math.sin(mid) * R * 0.5,
      });
    }
  }

  burstCrumbs(norm: Vec, count: number, power: number): void {
    const p = this.toScreen(norm);
    const n = this.effects === 'high' ? count : Math.ceil(count / 2);
    this.particles.crumbs(p.x, p.y, n, power * this.layout.k);
  }

  sparkleContour(contour: Contour, count: number): void {
    const n = this.effects === 'high' ? count : Math.ceil(count / 2);
    for (let i = 0; i < n; i++) {
      const pt = contour.points[Math.floor((i / n) * contour.points.length)];
      const s = this.toScreen(pt);
      this.particles.sparks(s.x, s.y, 1, this.layout.k);
    }
  }

  // ---------------------------------------------------------------- frame

  render(f: FrameState): void {
    const L = this.layout;
    const ctx = this.ctx;
    if (!this.bg) this.buildBackground();
    if (!this.plate) this.buildPlate();
    if (this.contour && !this.cookie) this.buildCookie();
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.bg!, 0, 0, L.w, L.h);

    const shakeAmp = this.effects === 'high' ? f.shake : f.shake * 0.3;
    const sx = shakeAmp ? Math.sin(f.time * 61) * shakeAmp : 0;
    const sy = shakeAmp ? Math.cos(f.time * 47) * shakeAmp : 0;
    const S = this.cacheSize;
    const ox = L.cx - S / 2;
    const oy = L.cy - S / 2;

    ctx.drawImage(this.plate!, ox, oy, S, S);

    if (this.cookie && this.contour) {
      this.updateTraceLayer(f.tracker);
      this.updateCrackLayer(f.cracks, f.phase === 'breaking');
      if (f.phase === 'breaking') {
        this.drawBreaking(f, ox, oy, S);
      } else if (f.phase === 'success') {
        this.drawSuccess(f, ox + sx, oy + sy, S);
      } else {
        let alpha = 1;
        let dy = 0;
        if (f.phase === 'intro') {
          const p = easeOutCubic(f.phaseT / 0.55);
          alpha = p;
          dy = -L.R * 0.12 * (1 - p);
        }
        ctx.globalAlpha = alpha;
        this.drawCookieStack(ox + sx, oy + sy + dy, S);
        ctx.globalAlpha = 1;
        if (f.phase === 'timeout') this.drawMissed(f);
      }
    }

    this.particles.update(f.dt);
    this.particles.draw(ctx);
    this.drawNeedle(f);
  }

  private drawCookieStack(x: number, y: number, S: number): void {
    const ctx = this.ctx;
    ctx.drawImage(this.cookie!, x, y, S, S);
    ctx.drawImage(this.traceLayer!, x, y, S, S);
    ctx.drawImage(this.crackLayer!, x, y, S, S);
  }

  private drawSuccess(f: FrameState, x: number, y: number, S: number): void {
    const ctx = this.ctx;
    const L = this.layout;
    const p = easeOutCubic(f.phaseT / 0.7);
    const lift = p * L.R * 0.07;
    if (!this.contour!.closed || !this.shapePath) {
      // Open shape (spiral): the whole cookie rises with a shine.
      ctx.save();
      ctx.translate(0, -lift);
      this.drawCookieStack(x, y, S);
      ctx.restore();
      return;
    }
    this.drawCookieStack(x, y, S);
    ctx.save();
    ctx.translate(x - (L.cx - S / 2), y - (L.cy - S / 2));
    // Cavity left behind.
    ctx.fillStyle = `rgba(30,12,2,${(0.62 * p).toFixed(3)})`;
    ctx.fill(this.shapePath);
    // Shadow of lifted piece.
    ctx.save();
    ctx.translate(L.R * 0.03 * p, L.R * 0.05 * p);
    ctx.fillStyle = `rgba(0,0,0,${(0.4 * p).toFixed(3)})`;
    ctx.fill(this.shapePath);
    ctx.restore();
    // Lifted piece.
    const sc = 1 + 0.035 * p;
    ctx.translate(L.cx, L.cy - lift);
    ctx.scale(sc, sc);
    ctx.translate(-L.cx, -L.cy);
    ctx.save();
    ctx.clip(this.shapePath);
    this.drawCookieStack(L.cx - S / 2, L.cy - S / 2, S);
    if (this.effects === 'high') {
      const sweep = (f.phaseT / 1.2) * (L.R * 4) - L.R * 2;
      const gr = ctx.createLinearGradient(L.cx + sweep - L.R * 0.4, L.cy - L.R, L.cx + sweep + L.R * 0.4, L.cy + L.R);
      gr.addColorStop(0, 'rgba(255,230,170,0)');
      gr.addColorStop(0.5, 'rgba(255,230,170,0.35)');
      gr.addColorStop(1, 'rgba(255,230,170,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = gr;
      ctx.fillRect(L.cx - L.R * 1.2, L.cy - L.R * 1.2, L.R * 2.4, L.R * 2.4);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
    ctx.strokeStyle = `rgba(255,214,140,${(0.7 * p).toFixed(3)})`;
    ctx.lineWidth = 1.4 * L.k;
    ctx.stroke(this.shapePath);
    ctx.restore();
  }

  private drawBreaking(f: FrameState, ox: number, oy: number, S: number): void {
    const ctx = this.ctx;
    const L = this.layout;
    const t = f.phaseT;
    const C = { x: L.cx, y: L.cy };
    const clipCircle = new Path2D();
    clipCircle.arc(L.cx, L.cy, L.R * 1.06, 0, Math.PI * 2);
    for (const pc of this.pieces) {
      const spread = easeOutCubic(t / 0.6) * pc.speed * 0.6 + Math.max(0, t - 0.15) * pc.speed * 0.25;
      const drop = Math.max(0, t - 0.35) ** 2 * L.R * 0.9;
      const rot = pc.spin * easeOutCubic(t / 0.8);
      const dx = Math.cos(pc.dir) * spread;
      const dy = Math.sin(pc.dir) * spread + drop;
      const alpha = clamp(1 - (t - 0.9) / 0.6, 0, 1);
      if (alpha <= 0) continue;
      const poly = new Path2D();
      pc.poly.forEach((p, i) => (i === 0 ? poly.moveTo(C.x + p.x, C.y + p.y) : poly.lineTo(C.x + p.x, C.y + p.y)));
      poly.closePath();
      ctx.save();
      ctx.globalAlpha = alpha;
      const pcx = C.x + pc.cx;
      const pcy = C.y + pc.cy;
      // Shadow
      ctx.save();
      ctx.translate(dx + L.R * 0.04 + drop * 0.1, dy + L.R * 0.07);
      ctx.translate(pcx, pcy);
      ctx.rotate(rot);
      ctx.translate(-pcx, -pcy);
      ctx.clip(poly);
      ctx.clip(clipCircle);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(L.cx - L.R * 1.2, L.cy - L.R * 1.2, L.R * 2.4, L.R * 2.4);
      ctx.restore();
      // Piece
      ctx.translate(dx, dy);
      ctx.translate(pcx, pcy);
      ctx.rotate(rot);
      ctx.translate(-pcx, -pcy);
      ctx.clip(poly);
      ctx.clip(clipCircle);
      this.drawCookieStack(ox, oy, S);
      ctx.strokeStyle = 'rgba(70,30,4,0.9)';
      ctx.lineWidth = 1.6 * L.k;
      ctx.stroke(poly);
      ctx.restore();
    }
  }

  private drawMissed(f: FrameState): void {
    const tracker = f.tracker;
    if (!tracker) return;
    const ctx = this.ctx;
    const L = this.layout;
    const p = clamp(f.phaseT / 0.4, 0, 1);
    ctx.fillStyle = `rgba(10,6,4,${(0.35 * p).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(L.cx, L.cy, L.R * 1.01, 0, Math.PI * 2);
    ctx.fill();
    const pts = tracker.contour.points;
    const n = pts.length;
    const segs = tracker.contour.closed ? n : n - 1;
    ctx.strokeStyle = `rgba(255,96,72,${(0.85 * p).toFixed(3)})`;
    ctx.lineWidth = 2.2 * L.k;
    ctx.lineCap = 'round';
    ctx.setLineDash([4 * L.k, 4 * L.k]);
    ctx.beginPath();
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      if (!tracker.visited[i] || !tracker.visited[j]) {
        ctx.moveTo(L.cx + pts[i].x * L.scale, L.cy + pts[i].y * L.scale);
        ctx.lineTo(L.cx + pts[j].x * L.scale, L.cy + pts[j].y * L.scale);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawNeedle(f: FrameState): void {
    const n = f.needle;
    if (!n.visible) return;
    const ctx = this.ctx;
    const L = this.layout;
    const k = L.k;
    if (!this.needleInit) {
      this.needlePos = { x: n.x, y: n.y };
      this.needleInit = true;
    }
    // Light smoothing (≈20 ms) for visual polish without perceptible lag.
    const a = 1 - Math.exp(-f.dt * 50);
    this.needlePos.x += (n.x - this.needlePos.x) * a;
    this.needlePos.y += (n.y - this.needlePos.y) * a;
    if (Math.hypot(n.x - this.needlePos.x, n.y - this.needlePos.y) > L.R) this.needlePos = { x: n.x, y: n.y };
    const targetLift = n.down ? 0 : 1;
    this.needleLift += (targetLift - this.needleLift) * (1 - Math.exp(-f.dt * 18));
    const lift = this.needleLift * 12 * k;
    const tx = this.needlePos.x;
    const ty = this.needlePos.y;
    const ang = -0.95; // needle points down-left toward the tip
    const len = Math.min(L.R * 1.05, 210 * k);
    const w = 1.5 * k;

    // Tip feedback ring.
    if (n.down) {
      const strain = clamp(n.strain, 0, 1);
      const col = n.onPath ? `rgba(255,214,140,${(0.35 + 0.25 * (1 - strain)).toFixed(2)})` : `rgba(255,86,60,${(0.55 + 0.35 * strain).toFixed(2)})`;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.arc(tx, ty, (6 + strain * 6) * k, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Shadow cast on the cookie (offset grows with lift).
    ctx.save();
    ctx.translate(tx + 2 * k + lift * 0.5, ty + 3 * k + lift * 0.9);
    ctx.rotate(ang);
    ctx.fillStyle = `rgba(0,0,0,${(0.28 - this.needleLift * 0.1).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len * 0.2, -w * 1.4);
    ctx.lineTo(len, -w * 4);
    ctx.lineTo(len, w * 4);
    ctx.lineTo(len * 0.2, w * 1.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Needle body in local space (x along the needle).
    ctx.save();
    ctx.translate(tx, ty - lift);
    ctx.rotate(ang);
    const steel = ctx.createLinearGradient(0, -w, 0, w);
    steel.addColorStop(0, '#50555b');
    steel.addColorStop(0.3, '#f3f5f7');
    steel.addColorStop(0.55, '#aab0b6');
    steel.addColorStop(1, '#33373b');
    ctx.fillStyle = steel;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len * 0.18, -w);
    ctx.lineTo(len * 0.72, -w);
    ctx.lineTo(len * 0.72, w);
    ctx.lineTo(len * 0.18, w);
    ctx.closePath();
    ctx.fill();
    // Specular line.
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(len * 0.05, -w * 0.25);
    ctx.lineTo(len * 0.7, -w * 0.45);
    ctx.stroke();
    // Brass collar.
    const brass = ctx.createLinearGradient(0, -w * 2.6, 0, w * 2.6);
    brass.addColorStop(0, '#6e4e1c');
    brass.addColorStop(0.35, '#f0cf7a');
    brass.addColorStop(0.7, '#b48a3a');
    brass.addColorStop(1, '#4e3510');
    ctx.fillStyle = brass;
    ctx.fillRect(len * 0.7, -w * 2.6, len * 0.06, w * 5.2);
    // Lacquered walnut grip.
    const grip = ctx.createLinearGradient(0, -w * 3.6, 0, w * 3.6);
    grip.addColorStop(0, '#24140c');
    grip.addColorStop(0.3, '#7a4a2c');
    grip.addColorStop(0.55, '#4a2a18');
    grip.addColorStop(1, '#160b06');
    ctx.fillStyle = grip;
    ctx.beginPath();
    const gx = len * 0.76;
    const gw = len * 0.5;
    const gh = w * 3.6;
    ctx.moveTo(gx, -gh * 0.85);
    ctx.lineTo(gx + gw - gh, -gh);
    ctx.arc(gx + gw - gh, 0, gh, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(gx, gh * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,180,0.18)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(gx + 2, -gh * 0.5);
    ctx.lineTo(gx + gw - gh, -gh * 0.6);
    ctx.stroke();
    ctx.restore();
  }

  resetNeedle(x: number, y: number): void {
    this.needlePos = { x, y };
    this.needleInit = true;
    this.needleLift = 1;
  }
}
