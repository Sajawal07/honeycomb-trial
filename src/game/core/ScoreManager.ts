/**
 * ScoreManager
 * Round rewards with accuracy, time, integrity bonuses and a clean-streak
 * multiplier. Each round token can only be rewarded once.
 */

export interface RoundResult {
  round: number;
  accuracy: number;
  timeLeft: number;
  timeLimit: number;
  integrityFrac: number;
}

export interface RoundReward {
  base: number;
  accuracyBonus: number;
  timeBonus: number;
  integrityBonus: number;
  multiplier: number;
  total: number;
  coins: number;
  streak: number;
}

export interface RunSummary {
  score: number;
  rounds: number;
  coins: number;
  accuracy: number;
  bestStreak: number;
}

export const CLEAN_ACCURACY = 0.85;

export class ScoreManager {
  score = 0;
  coins = 0;
  rounds = 0;
  streak = 0;
  bestStreak = 0;
  private accuracySum = 0;
  private awarded = new Set<string>();

  startRun(): void {
    this.score = 0;
    this.coins = 0;
    this.rounds = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.accuracySum = 0;
    this.awarded.clear();
  }

  static compute(r: RoundResult, streak: number): RoundReward {
    const acc = Math.max(0, Math.min(1, r.accuracy));
    const timeFrac = r.timeLimit > 0 ? Math.max(0, Math.min(1, r.timeLeft / r.timeLimit)) : 0;
    const base = Math.round(100 * (1 + r.round * 0.15));
    const accuracyBonus = Math.round(acc * acc * 150);
    const timeBonus = Math.round(timeFrac * 120);
    const integrityBonus = Math.round(Math.max(0, Math.min(1, r.integrityFrac)) * 60);
    const multiplier = Math.round((1 + Math.min(streak, 10) * 0.1) * 100) / 100;
    const total = Math.round((base + accuracyBonus + timeBonus + integrityBonus) * multiplier);
    const coins = 5 + Math.floor(acc * 5) + Math.floor(timeFrac * 5) + Math.min(streak, 10);
    return { base, accuracyBonus, timeBonus, integrityBonus, multiplier, total, coins, streak };
  }

  /** Returns null if this round token was already rewarded. */
  awardRound(token: string, r: RoundResult): RoundReward | null {
    if (this.awarded.has(token)) return null;
    this.awarded.add(token);
    const clean = r.accuracy >= CLEAN_ACCURACY;
    const nextStreak = clean ? this.streak + 1 : 0;
    const reward = ScoreManager.compute(r, nextStreak);
    this.streak = nextStreak;
    this.bestStreak = Math.max(this.bestStreak, nextStreak);
    this.score += reward.total;
    this.coins += reward.coins;
    this.rounds += 1;
    this.accuracySum += r.accuracy;
    return reward;
  }

  summary(lastAccuracy?: number): RunSummary {
    // Average accuracy over cleared rounds, including the failed attempt if provided.
    const count = this.rounds + (lastAccuracy !== undefined ? 1 : 0);
    const sum = this.accuracySum + (lastAccuracy ?? 0);
    return {
      score: this.score,
      rounds: this.rounds,
      coins: this.coins,
      accuracy: count > 0 ? sum / count : 0,
      bestStreak: this.bestStreak,
    };
  }
}
