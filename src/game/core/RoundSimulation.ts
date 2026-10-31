import { CrackSimulator } from './CrackSimulator';
import { DifficultyManager } from './DifficultyManager';
import type { Contour } from './ShapeFactory';
import { TraceTracker } from './TraceController';
import type { DifficultyParams, RoundStatus, SimEvent, Vec } from './types';

export const SIM_DT = 1 / 60;

export interface InputSample {
  type: 'down' | 'move' | 'up';
  x: number;
  y: number;
}

/**
 * RoundSimulation
 * Pure, deterministic round model stepped at a fixed timestep. Pointer samples
 * (already converted to normalized shape coordinates) are queued and consumed
 * in order on each step, so identical input sequences give identical results.
 */
export class RoundSimulation {
  readonly contour: Contour;
  readonly params: DifficultyParams;
  readonly tracker: TraceTracker;
  readonly cracks: CrackSimulator;
  readonly timeLimit: number;
  readonly token: string;
  timeLeft: number;
  elapsed = 0;
  status: RoundStatus = 'playing';
  speed = 0;
  turnRate = 0;
  vx = 0;
  vy = 0;
  needle: Vec | null = null;
  private queue: InputSample[] = [];
  private prevDir: number | null = null;
  private lastWholeSecond: number;

  constructor(contour: Contour, params: DifficultyParams, seed: number, token: string) {
    this.contour = contour;
    this.params = params;
    this.token = token;
    this.tracker = new TraceTracker(contour, params.tolerance);
    this.cracks = new CrackSimulator(
      contour,
      {
        maxIntegrity: params.integrity,
        sensitivity: params.sensitivity,
        tolerance: params.tolerance,
        safeSpeed: params.safeSpeed,
      },
      seed,
    );
    this.timeLimit = DifficultyManager.timeLimit(params, contour);
    this.timeLeft = this.timeLimit;
    this.lastWholeSecond = Math.ceil(this.timeLeft);
  }

  push(sample: InputSample): void {
    if (this.status !== 'playing') return;
    // Bound queue growth (e.g. very high-rate stylus input).
    if (this.queue.length > 512) this.queue.splice(0, this.queue.length - 512);
    this.queue.push(sample);
  }

  /** Force-lift the needle (pause, touch cancel, backgrounding). */
  cancelInput(): void {
    this.queue.length = 0;
    this.tracker.penUp();
    this.speed = 0;
    this.vx = 0;
    this.vy = 0;
    this.prevDir = null;
  }

  get coverage(): number {
    return this.tracker.coverage;
  }

  step(dt: number, events: SimEvent[]): void {
    if (this.status !== 'playing') {
      this.queue.length = 0;
      return;
    }
    let moved = 0;
    let devSum = 0;
    let retraced = 0;
    let dx = 0;
    let dy = 0;
    const startPos = this.tracker.lastPos ? { ...this.tracker.lastPos } : null;
    for (const s of this.queue) {
      const p = { x: s.x, y: s.y };
      if (s.type === 'down') {
        this.tracker.penDown(p);
        this.needle = p;
        this.prevDir = null;
      } else if (s.type === 'move') {
        if (!this.tracker.penIsDown) continue;
        const r = this.tracker.moveTo(p);
        moved += r.moved;
        devSum += r.meanDeviation * r.moved;
        retraced += r.retraced;
        if (r.jumped) events.push({ type: 'jump' });
        this.needle = p;
      } else {
        this.tracker.penUp();
      }
    }
    this.queue.length = 0;
    if (startPos && this.tracker.lastPos) {
      dx = this.tracker.lastPos.x - startPos.x;
      dy = this.tracker.lastPos.y - startPos.y;
    }

    const down = this.tracker.penIsDown;
    // Smoothed velocity vector: sensor noise cancels out, real speed remains.
    const k = 0.3;
    this.vx += ((down ? dx / dt : 0) - this.vx) * k;
    this.vy += ((down ? dy / dt : 0) - this.vy) * k;
    this.speed = Math.hypot(this.vx, this.vy);
    if (down && this.speed > 0.25) {
      const dir = Math.atan2(this.vy, this.vx);
      if (this.prevDir !== null) {
        let da = Math.abs(dir - this.prevDir);
        if (da > Math.PI) da = Math.PI * 2 - da;
        const tr = da / dt;
        this.turnRate += (tr - this.turnRate) * 0.4;
      }
      this.prevDir = dir;
    } else {
      this.turnRate *= 0.8;
      if (!down) this.prevDir = null;
    }

    const deviation = moved > 0 ? Math.max(devSum / moved, this.tracker.deviation * 0.5) : this.tracker.deviation;
    this.cracks.step(
      dt,
      {
        down,
        deviation,
        nearestIdx: this.tracker.nearestIdx,
        speed: this.speed,
        turnRate: this.turnRate,
        retraced,
        pos: this.tracker.lastPos,
      },
      events,
    );

    this.elapsed += dt;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    const whole = Math.ceil(this.timeLeft);
    if (whole < this.lastWholeSecond) {
      this.lastWholeSecond = whole;
      if (whole <= 5 && whole > 0) events.push({ type: 'tick', value: whole });
    }

    if (this.cracks.integrity <= 0) {
      this.status = 'broken';
      this.tracker.penUp();
    } else if (this.tracker.coverage >= this.params.requiredCoverage) {
      this.status = 'success';
      this.tracker.penUp();
      events.push({ type: 'success' });
    } else if (this.timeLeft <= 0) {
      this.status = 'timeout';
      this.tracker.penUp();
      events.push({ type: 'timeout' });
    }
  }
}
