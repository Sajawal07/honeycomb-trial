import type { Contour } from './ShapeFactory';
import { mulberry32 } from './rng';
import type { CookieState, SimEvent, Vec } from './types';
import { clamp } from './types';

/**
 * CrackSimulator
 * Deterministic stress model. Stress comes only from player actions:
 *  - distance outside the safe corridor
 *  - time spent outside the corridor
 *  - excessive / erratic needle speed
 *  - repeated stress on the same cookie region (heat map)
 *  - remaining integrity (damaged cookies are more fragile)
 *  - difficulty sensitivity
 * Cracks spawn when accumulated damage crosses thresholds and branch out from
 * the stressed contour point using a seeded RNG so identical input produces
 * identical cracks.
 */

export interface CrackSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  gen: number;
  /** Order index for growth animation. */
  order: number;
  /** Simulation time at which this segment appears (staggered growth). */
  born: number;
}

export interface Crack {
  id: number;
  originIdx: number;
  bin: number;
  segments: CrackSegment[];
  tip: Vec;
  dir: number;
  bornAt: number;
  grownAt: number;
  depth: number;
}

export interface StressInput {
  down: boolean;
  deviation: number;
  nearestIdx: number;
  speed: number;
  turnRate: number;
  retraced: number;
  pos: Vec | null;
}

export interface CrackConfig {
  maxIntegrity: number;
  sensitivity: number;
  tolerance: number;
  safeSpeed: number;
}

export const STRESS_TUNING = {
  devWeight: 0.9,
  outsideTimeWeight: 0.6,
  edgeWeight: 0.25,
  speedWeight: 1.2,
  erraticWeight: 0.6,
  retraceWeight: 0.15,
  heatWeight: 0.35,
  damagePerStress: 14,
  crackEvery: 4.5,
  lightThreshold: 0.72,
  severeThreshold: 0.4,
  /** Cookie radius in normalized shape units (shape scale is 0.74 of cookie radius). */
  cookieRadius: 1 / 0.74,
  maxSegments: 520,
};

const BINS = 24;

export class CrackSimulator {
  readonly config: CrackConfig;
  readonly contour: Contour;
  integrity: number;
  strain = 0;
  outsideTime = 0;
  time = 0;
  readonly heat = new Float32Array(BINS);
  cracks: Crack[] = [];
  segmentCount = 0;
  damageAccum = 0;
  totalDamage = 0;
  lastStressPos: Vec = { x: 0, y: 0 };
  revision = 0;
  /** Latest segment birth time (renderer animates until this passes). */
  latestBorn = 0;
  private rng: () => number;
  private order = 0;
  private burstIndex = 0;

  constructor(contour: Contour, config: CrackConfig, seed: number) {
    this.contour = contour;
    this.config = config;
    this.integrity = config.maxIntegrity;
    this.rng = mulberry32(seed);
  }

  get integrityFrac(): number {
    return clamp(this.integrity / this.config.maxIntegrity, 0, 1);
  }

  get state(): CookieState {
    const f = this.integrityFrac;
    if (this.integrity <= 0) return 'broken';
    if (f < STRESS_TUNING.severeThreshold) return 'severe';
    if (f < STRESS_TUNING.lightThreshold) return 'light';
    return 'intact';
  }

  /** Instantaneous stress units for a given input (exposed for tests/UI). */
  computeStress(input: StressInput, dt: number): number {
    const T = STRESS_TUNING;
    const tol = this.config.tolerance;
    let s = 0;
    const dr = input.deviation / tol;
    if (dr > 1) {
      this.outsideTime += dt;
      s += T.devWeight * Math.min(dr - 1, 4) + T.outsideTimeWeight * Math.min(this.outsideTime, 2.5);
    } else {
      this.outsideTime = Math.max(0, this.outsideTime - dt * 3);
      if (dr > 0.7) s += (dr - 0.7) * T.edgeWeight;
    }
    const safe = this.config.safeSpeed;
    if (input.speed > safe) s += ((input.speed - safe) / safe) * T.speedWeight;
    if (input.speed > safe * 0.6 && input.turnRate > 14) {
      s += Math.min((input.turnRate - 14) / 20, 1) * T.erraticWeight;
    }
    if (dt > 0 && input.retraced > 0) s += (input.retraced / dt) * 0.02 * T.retraceWeight;
    return s;
  }

  step(dt: number, input: StressInput, events: SimEvent[]): void {
    this.time += dt;
    const T = STRESS_TUNING;
    const heatDecay = Math.exp(-dt * 0.15);
    for (let i = 0; i < BINS; i++) this.heat[i] *= heatDecay;
    if (!input.down || this.integrity <= 0) {
      this.outsideTime = 0;
      this.strain += (0 - this.strain) * Math.min(1, dt * 6);
      return;
    }
    const n = this.contour.points.length;
    const bin = Math.min(BINS - 1, Math.floor((input.nearestIdx / n) * BINS));
    let s = this.computeStress(input, dt);
    const heatMul = 1 + Math.min(this.heat[bin], 3) * T.heatWeight;
    s *= this.config.sensitivity * heatMul;
    this.heat[bin] += s * dt * 0.8;
    const fragility = 1 + (1 - this.integrityFrac) * 0.5;
    const damage = s * fragility * T.damagePerStress * dt;
    const target = clamp(s / 2.5, 0, 1);
    this.strain += (target - this.strain) * Math.min(1, dt * (target > this.strain ? 10 : 4));
    if (damage <= 0) return;

    if (input.pos) this.lastStressPos = { x: input.pos.x, y: input.pos.y };
    this.integrity = Math.max(0, this.integrity - damage);
    this.totalDamage += damage;
    this.damageAccum += damage;
    while (this.damageAccum >= T.crackEvery && this.integrity > 0) {
      this.damageAccum -= T.crackEvery;
      this.spawnOrGrow(input.nearestIdx, bin, input.pos, events);
    }
    if (this.integrity <= 0) {
      events.push({ type: 'break', x: this.lastStressPos.x, y: this.lastStressPos.y });
    }
  }

  private spawnOrGrow(idx: number, bin: number, pos: Vec | null, events: SimEvent[]): void {
    const severity = 1 - this.integrityFrac;
    this.burstIndex = 0;
    const existing = this.cracks.find((c) => c.bin === bin);
    if (existing && existing.depth < 5) {
      existing.depth++;
      existing.grownAt = this.time;
      this.walk(existing, existing.tip.x, existing.tip.y, existing.dir, 0.12 + severity * 0.18, 0, 2.0 - existing.depth * 0.15);
      this.revision++;
      events.push({ type: 'crackGrow', x: existing.tip.x, y: existing.tip.y, severity });
      return;
    }
    const p = this.contour.points[idx];
    const nrm = this.contour.normals[idx];
    let ox = p.x;
    let oy = p.y;
    if (pos) {
      // Origin between the contour point and the stressed needle position.
      const dx = pos.x - p.x;
      const dy = pos.y - p.y;
      const d = Math.hypot(dx, dy);
      const k = Math.min(1, 0.25 / Math.max(d, 1e-6));
      ox = p.x + dx * Math.min(1, k) * 0.6;
      oy = p.y + dy * Math.min(1, k) * 0.6;
    }
    const sign = this.rng() < 0.5 ? -1 : 1;
    const dir = Math.atan2(nrm.y * sign, nrm.x * sign) + (this.rng() - 0.5) * 0.9;
    const crack: Crack = {
      id: this.cracks.length,
      originIdx: idx,
      bin,
      segments: [],
      tip: { x: ox, y: oy },
      dir,
      bornAt: this.time,
      grownAt: this.time,
      depth: 1,
    };
    this.cracks.push(crack);
    this.walk(crack, ox, oy, dir, 0.16 + severity * 0.26, 0, 2.2);
    // Second arm in the opposite direction for a realistic fracture.
    this.walk(crack, ox, oy, dir + Math.PI + (this.rng() - 0.5) * 0.6, 0.08 + severity * 0.12, 1, 1.6, false);
    this.revision++;
    events.push({ type: 'crack', x: ox, y: oy, severity });
  }

  private walk(crack: Crack, x: number, y: number, dir: number, length: number, gen: number, width: number, updateTip = true): void {
    const R = STRESS_TUNING.cookieRadius * 0.97;
    let travelled = 0;
    let a = dir;
    let w = width;
    while (travelled < length && this.segmentCount < STRESS_TUNING.maxSegments) {
      const step = 0.035 + this.rng() * 0.035;
      a += (this.rng() - 0.5) * 0.9;
      let nx = x + Math.cos(a) * step;
      let ny = y + Math.sin(a) * step;
      const r = Math.hypot(nx, ny);
      if (r > R) {
        nx = (nx / r) * R;
        ny = (ny / r) * R;
      }
      crack.segments.push({
        x1: x,
        y1: y,
        x2: nx,
        y2: ny,
        width: w,
        gen,
        order: this.order++,
        born: this.time + this.burstIndex++ * 0.012,
      });
      if (this.time + this.burstIndex * 0.012 > this.latestBorn) this.latestBorn = this.time + this.burstIndex * 0.012;
      this.segmentCount++;
      travelled += step;
      x = nx;
      y = ny;
      w = Math.max(0.5, w * 0.88);
      if (r > R) break;
      if (gen < 2 && this.rng() < 0.22) {
        const side = this.rng() < 0.5 ? -1 : 1;
        this.walk(crack, x, y, a + side * (0.6 + this.rng() * 0.6), (length - travelled) * 0.55, gen + 1, w * 0.7, false);
      }
    }
    if (updateTip) {
      crack.tip = { x, y };
      crack.dir = a;
    }
  }
}
