import type { RunSummary } from '../core/ScoreManager';
import { SHAPE_IDS } from '../core/ShapeFactory';

/**
 * StorageManager
 * Local persistence with validation. Corrupted or unavailable storage falls
 * back to safe defaults / in-memory data without crashing the game.
 */

export interface Settings {
  sound: boolean;
  vibration: boolean;
  effects: 'high' | 'low';
  needleOffset: boolean;
}

export interface LastRun extends RunSummary {
  reason: 'broken' | 'timeout' | 'quit';
  at: number;
}

export interface SaveData {
  version: 1;
  bestScore: number;
  bestRounds: number;
  bestAccuracy: number;
  totalRounds: number;
  totalCoins: number;
  gamesPlayed: number;
  lastRun: LastRun | null;
  /** Design ids the player has successfully extracted at least once. */
  discovered: string[];
  settings: Settings;
}

const KEY = 'honeycomb-trial.save.v1';

export function defaultSave(): SaveData {
  return {
    version: 1,
    bestScore: 0,
    bestRounds: 0,
    bestAccuracy: 0,
    totalRounds: 0,
    totalCoins: 0,
    gamesPlayed: 0,
    lastRun: null,
    discovered: [],
    settings: { sound: true, vibration: true, effects: 'high', needleOffset: false },
  };
}

function num(v: unknown, fallback = 0, max = 1e12): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function sanitize(raw: unknown): SaveData {
  const d = defaultSave();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  d.bestScore = Math.floor(num(r.bestScore));
  d.bestRounds = Math.floor(num(r.bestRounds));
  d.bestAccuracy = num(r.bestAccuracy, 0, 1);
  d.totalRounds = Math.floor(num(r.totalRounds));
  d.totalCoins = Math.floor(num(r.totalCoins));
  d.gamesPlayed = Math.floor(num(r.gamesPlayed));
  if (Array.isArray(r.discovered)) {
    d.discovered = Array.from(new Set(r.discovered.filter((v): v is string => typeof v === 'string' && SHAPE_IDS.has(v))));
  }
  const s = (r.settings && typeof r.settings === 'object' ? r.settings : {}) as Record<string, unknown>;
  d.settings = {
    sound: bool(s.sound, true),
    vibration: bool(s.vibration, true),
    effects: s.effects === 'low' ? 'low' : 'high',
    needleOffset: bool(s.needleOffset, false),
  };
  const lr = r.lastRun as Record<string, unknown> | null | undefined;
  if (lr && typeof lr === 'object') {
    d.lastRun = {
      score: Math.floor(num(lr.score)),
      rounds: Math.floor(num(lr.rounds)),
      coins: Math.floor(num(lr.coins)),
      accuracy: num(lr.accuracy, 0, 1),
      bestStreak: Math.floor(num(lr.bestStreak)),
      reason: lr.reason === 'timeout' ? 'timeout' : lr.reason === 'quit' ? 'quit' : 'broken',
      at: num(lr.at),
    };
  }
  return d;
}

export class StorageManager {
  data: SaveData;
  private available: boolean;

  constructor() {
    this.available = StorageManager.probe();
    this.data = this.load();
  }

  static probe(): boolean {
    try {
      const k = '__hc_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch {
      return false;
    }
  }

  get isPersistent(): boolean {
    return this.available;
  }

  load(): SaveData {
    if (!this.available) return defaultSave();
    try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return defaultSave();
      return sanitize(JSON.parse(raw));
    } catch {
      return defaultSave();
    }
  }

  save(): void {
    if (!this.available) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Quota or privacy mode: keep playing with in-memory data.
    }
  }

  /** Coins & rounds are banked immediately per cleared round. */
  /** Banks a cleared round. Returns true when the design was extracted for the first time. */
  bankRound(coins: number, shapeId?: string): boolean {
    this.data.totalCoins += Math.max(0, Math.floor(coins));
    this.data.totalRounds += 1;
    let isNew = false;
    if (shapeId && SHAPE_IDS.has(shapeId) && !this.data.discovered.includes(shapeId)) {
      this.data.discovered.push(shapeId);
      isNew = true;
    }
    this.save();
    return isNew;
  }

  /** Spends coins if player has enough. Returns true if successful. */
  spendCoins(amount: number): boolean {
    const cost = Math.max(0, Math.floor(amount));
    if (this.data.totalCoins < cost) return false;
    this.data.totalCoins -= cost;
    this.save();
    return true;
  }

  /** Records a finished run; returns true when it set a new best score. */
  recordRun(summary: RunSummary, reason: LastRun['reason']): boolean {
    const d = this.data;
    const isBest = summary.score > d.bestScore;
    d.bestScore = Math.max(d.bestScore, summary.score);
    d.bestRounds = Math.max(d.bestRounds, summary.rounds);
    if (summary.rounds > 0) d.bestAccuracy = Math.max(d.bestAccuracy, summary.accuracy);
    d.gamesPlayed += 1;
    d.lastRun = { ...summary, reason, at: Date.now() };
    this.save();
    return isBest;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }

  resetProgress(): void {
    const settings = this.data.settings;
    this.data = defaultSave();
    this.data.settings = settings;
    this.save();
  }
}
