import type { Contour } from './ShapeFactory';
import type { Vec } from './types';

/**
 * TraceController (pure logic, no DOM)
 * - Finds the nearest valid contour segment for each needle sample.
 * - Tracks coverage per contour point: a point is only marked when the needle
 *   travels continuously along the contour inside the tolerance corridor.
 * - Taps, jumps between distant sections and shortcuts across the cookie
 *   never mark coverage.
 */

/** Max distance (normalized units) a single pointer sample may travel. */
export const TELEPORT_DISTANCE = 0.32;

export interface NearestHit {
  idx: number;
  dist: number;
}

export interface SampleResult {
  /** Total moved length in this update (normalized units). */
  moved: number;
  /** Length-weighted mean deviation over the update. */
  meanDeviation: number;
  /** Deviation of the final sample. */
  deviation: number;
  /** Nearest contour index of the final sample. */
  nearestIdx: number;
  /** Points newly covered. */
  newlyCovered: number;
  /** Length of movement over already covered contour (re-scraping). */
  retraced: number;
  /** A discontinuous jump occurred. */
  jumped: boolean;
}

export class TraceTracker {
  readonly contour: Contour;
  tolerance: number;
  readonly visited: Uint8Array;
  visitedCount = 0;
  lastIdx = -1;
  lastPos: Vec | null = null;
  penIsDown = false;
  deviation = 0;
  nearestIdx = 0;
  onCorridor = false;
  jumps = 0;
  totalLen = 0;
  qualityLen = 0;
  /** Revision increments whenever coverage changes (for render caching). */
  revision = 0;
  private readonly maxStep: number;
  private readonly window: number;
  private readonly n: number;

  constructor(contour: Contour, tolerance: number) {
    this.contour = contour;
    this.tolerance = tolerance;
    this.n = contour.points.length;
    this.visited = new Uint8Array(this.n);
    // Max index advance per substep that still counts as continuous travel.
    this.maxStep = Math.max(3, Math.ceil(0.05 / contour.spacing));
    this.window = this.maxStep * 3;
  }

  get coverage(): number {
    return this.visitedCount / this.n;
  }

  get accuracy(): number {
    return this.totalLen > 0.05 ? this.qualityLen / this.totalLen : 1;
  }

  private segDist(px: number, py: number, i: number): NearestHit {
    const pts = this.contour.points;
    const n = this.n;
    const j = this.contour.closed ? (i + 1) % n : Math.min(i + 1, n - 1);
    const a = pts[i];
    const b = pts[j];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((px - a.x) * abx + (py - a.y) * aby) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a.x + abx * t - px;
    const qy = a.y + aby * t - py;
    return { idx: t < 0.5 ? i : j, dist: Math.sqrt(qx * qx + qy * qy) };
  }

  /** Nearest contour segment, preferring the local neighbourhood of the last match. */
  nearest(p: Vec): NearestHit {
    const n = this.n;
    const segCount = this.contour.closed ? n : n - 1;
    let best: NearestHit = { idx: 0, dist: Infinity };
    if (this.lastIdx >= 0) {
      for (let k = -this.window; k <= this.window; k++) {
        let i = this.lastIdx + k;
        if (this.contour.closed) i = ((i % n) + n) % n;
        else if (i < 0 || i >= segCount) continue;
        const h = this.segDist(p.x, p.y, i);
        if (h.dist < best.dist) best = h;
      }
      if (best.dist <= this.tolerance) return best;
    }
    for (let i = 0; i < segCount; i++) {
      const h = this.segDist(p.x, p.y, i);
      if (h.dist < best.dist) best = h;
    }
    return best;
  }

  private delta(from: number, to: number): number {
    let d = to - from;
    if (this.contour.closed) {
      const n = this.n;
      if (d > n / 2) d -= n;
      else if (d < -n / 2) d += n;
    }
    return d;
  }

  private mark(from: number, to: number): { added: number; already: number } {
    const d = this.delta(from, to);
    const dir = d >= 0 ? 1 : -1;
    const steps = Math.abs(d);
    let added = 0;
    let already = 0;
    let i = from;
    for (let s = 0; s <= steps; s++) {
      if (s > 0) {
        i += dir;
        if (this.contour.closed) i = (i + this.n) % this.n;
      }
      if (s === 0) continue; // anchor itself only counts after leaving it
      if (!this.visited[i]) {
        this.visited[i] = 1;
        this.visitedCount++;
        added++;
      } else already++;
    }
    // Credit the anchor point once real travel happened from it.
    if (steps > 0 && !this.visited[from]) {
      this.visited[from] = 1;
      this.visitedCount++;
      added++;
    }
    if (added) this.revision++;
    return { added, already };
  }

  penDown(p: Vec): SampleResult {
    this.penIsDown = true;
    this.lastIdx = -1;
    this.lastPos = { x: p.x, y: p.y };
    const r = this.emptyResult();
    this.sample(p, 0, r);
    this.finish(r);
    return r;
  }

  penUp(): void {
    this.penIsDown = false;
    this.lastIdx = -1;
    this.lastPos = null;
  }

  moveTo(p: Vec): SampleResult {
    const r = this.emptyResult();
    if (!this.penIsDown || !this.lastPos) {
      return this.penDown(p);
    }
    const from = this.lastPos;
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist > TELEPORT_DISTANCE) {
      // A single pointer sample jumped too far to be real needle travel
      // (glitch, multi-touch swap). Re-anchor without granting coverage.
      this.jumps++;
      this.lastIdx = -1;
      this.lastPos = { x: p.x, y: p.y };
      const hit = this.nearest(p);
      this.deviation = hit.dist;
      this.nearestIdx = hit.idx;
      this.onCorridor = hit.dist <= this.tolerance;
      if (this.onCorridor) this.lastIdx = hit.idx;
      r.jumped = true;
      this.finish(r);
      return r;
    }
    const stepLen = this.contour.spacing * 0.75;
    const steps = Math.min(400, Math.max(1, Math.ceil(dist / stepLen)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      this.sample({ x: from.x + dx * t, y: from.y + dy * t }, dist / steps, r);
    }
    this.lastPos = { x: p.x, y: p.y };
    this.finish(r);
    return r;
  }

  private emptyResult(): SampleResult {
    return { moved: 0, meanDeviation: 0, deviation: 0, nearestIdx: 0, newlyCovered: 0, retraced: 0, jumped: false };
  }

  private finish(r: SampleResult): void {
    r.meanDeviation = r.moved > 0 ? r.meanDeviation / r.moved : this.deviation;
    r.deviation = this.deviation;
    r.nearestIdx = this.nearestIdx;
  }

  private sample(q: Vec, len: number, r: SampleResult): void {
    const hit = this.nearest(q);
    this.deviation = hit.dist;
    this.nearestIdx = hit.idx;
    const tol = this.tolerance;
    const inside = hit.dist <= tol;
    this.onCorridor = inside;
    r.moved += len;
    r.meanDeviation += hit.dist * len;
    this.totalLen += len;
    if (inside) {
      const ratio = hit.dist / tol;
      this.qualityLen += len * (1 - 0.45 * ratio * ratio);
      if (this.lastIdx >= 0) {
        const d = this.delta(this.lastIdx, hit.idx);
        if (Math.abs(d) <= this.maxStep) {
          const m = this.mark(this.lastIdx, hit.idx);
          r.newlyCovered += m.added;
          r.retraced += m.already * this.contour.spacing;
        } else {
          // Teleport / slip to another section: re-anchor without credit.
          this.jumps++;
          r.jumped = true;
        }
      }
      this.lastIdx = hit.idx;
    } else {
      // Left the corridor: coverage chain is broken until re-entry.
      this.lastIdx = -1;
    }
  }
}
