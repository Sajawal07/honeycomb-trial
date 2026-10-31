import { SHAPES, type Contour } from './ShapeFactory';
import type { DifficultyParams, ShapeId } from './types';
import { clamp, lerp } from './types';

/** Complexity unlocked at round 0 and added per survived round. */
export const UNLOCK_BASE = 1.3;
export const UNLOCK_STEP = 0.16;

/**
 * DifficultyManager
 * Smooth exponential progression: forgiving at the start, asymptotically
 * approaching the hardest settings. No random spikes: shape choice is limited
 * to an unlocked complexity band that widens gradually.
 */
export class DifficultyManager {
  static progress(round: number): number {
    return 1 - Math.exp(-round / 9);
  }

  static params(round: number): DifficultyParams {
    const t = DifficultyManager.progress(Math.max(0, round));
    return {
      round,
      tolerance: lerp(0.15, 0.065, t),
      baseTime: lerp(42, 18, t),
      integrity: lerp(100, 60, t),
      sensitivity: lerp(0.8, 1.6, t),
      requiredCoverage: lerp(0.92, 0.97, t),
      safeSpeed: lerp(3.2, 2.3, t),
      maxComplexity: UNLOCK_BASE + round * UNLOCK_STEP,
    };
  }

  /** Time limit scaled by contour length so long outlines stay fair. */
  static timeLimit(params: DifficultyParams, contour: Contour): number {
    const circleLen = 2 * Math.PI * 0.82;
    const factor = clamp(Math.pow(contour.length / circleLen, 0.7), 0.9, 1.7);
    return Math.round(params.baseTime * factor);
  }

  /** First round (1-based) in which a design of this complexity can appear. */
  static unlockRound(complexity: number): number {
    return Math.max(0, Math.ceil((complexity - UNLOCK_BASE) / UNLOCK_STEP - 1e-9)) + 1;
  }

  /**
   * Picks a shape from the unlocked pool using a deterministic rng. Recently
   * seen designs are avoided (up to half the unlocked pool) so runs show a
   * wide variety; picks are biased toward more complex unlocked designs.
   */
  static pickShape(params: DifficultyParams, rng: () => number, recent: readonly ShapeId[] = []): ShapeId {
    const unlocked = SHAPES.filter((s) => s.complexity <= params.maxComplexity);
    const base = unlocked.length >= 2 ? unlocked : SHAPES;
    const avoidN = Math.min(recent.length, Math.max(1, Math.floor(base.length / 2)));
    const avoid = new Set(recent.slice(recent.length - avoidN));
    let pool = base.filter((s) => !avoid.has(s.id));
    if (pool.length === 0) pool = base.filter((s) => s.id !== recent[recent.length - 1]);
    const weights = pool.map((s) => 1 + s.complexity);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i].id;
    }
    return pool[pool.length - 1].id;
  }
}
