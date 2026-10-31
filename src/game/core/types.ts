export interface Vec {
  x: number;
  y: number;
}

export type ShapeId =
  | 'circle'
  | 'triangle'
  | 'star'
  | 'umbrella'
  | 'heart'
  | 'diamond'
  | 'flower'
  | 'spiral'
  | 'square'
  | 'hexagon'
  | 'moon'
  | 'cross'
  | 'arrow'
  | 'lightning'
  | 'leaf'
  | 'cloud'
  | 'house'
  | 'fish'
  | 'bell'
  | 'clover'
  | 'raindrop'
  | 'mushroom'
  | 'tree'
  | 'cat'
  | 'crown'
  | 'gear'
  | 'ghost'
  | 'shield';

export type CookieState = 'intact' | 'light' | 'severe' | 'broken';

export type RoundStatus = 'playing' | 'success' | 'broken' | 'timeout';

export interface DifficultyParams {
  round: number;
  /** Half-width of the safe tracing corridor in normalized shape units. */
  tolerance: number;
  /** Base time before shape-length adjustment (seconds). */
  baseTime: number;
  /** Max cookie integrity. */
  integrity: number;
  /** Stress multiplier. */
  sensitivity: number;
  /** Required fraction of contour that must be traced. */
  requiredCoverage: number;
  /** Needle speed (normalized units / second) above which stress builds. */
  safeSpeed: number;
  /** Highest shape complexity unlocked. */
  maxComplexity: number;
}

export interface SimEvent {
  type: 'crack' | 'crackGrow' | 'break' | 'success' | 'timeout' | 'tick' | 'jump';
  x?: number;
  y?: number;
  severity?: number;
  value?: number;
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
