import { DifficultyManager } from './core/DifficultyManager';
import { hashString, mulberry32 } from './core/rng';
import { RoundSimulation, SIM_DT } from './core/RoundSimulation';
import { ScoreManager } from './core/ScoreManager';
import { SHAPES, getContour } from './core/ShapeFactory';
import type { ShapeId, SimEvent } from './core/types';
import { PointerInput, type PointerKind } from './input/PointerInput';
import { CanvasRenderer, type RenderPhase } from './render/CanvasRenderer';
import { AudioManager } from './services/AudioManager';
import { Platform } from './services/Platform';
import { StorageManager, type Settings } from './services/StorageManager';
import { UIController } from './ui/UIController';

type GameState = 'home' | 'tutorial' | 'settings' | 'collection' | 'intro' | 'playing' | 'paused' | 'success' | 'breaking' | 'timeout' | 'gameover';

const INTRO_TIME = 1.25;
const SUCCESS_TIME = 2.2;
const BREAK_TIME = 1.7;
const TIMEOUT_TIME = 1.6;
const MAX_STEPS_PER_FRAME = 8;
const NEEDLE_OFFSET_PX = 46;
export const CONTINUE_COST = 50;

/**
 * GameEngine — state machine + main loop.
 * Rendering runs on requestAnimationFrame with delta time; the round
 * simulation advances in fixed SIM_DT steps (bounded per frame).
 */
export class GameEngine {
  private ui: UIController;
  private renderer: CanvasRenderer;
  private input: PointerInput;
  private audio = new AudioManager();
  private storage = new StorageManager();
  private platform = new Platform();
  private score = new ScoreManager();

  private state: GameState = 'home';
  private pausedFrom: GameState | null = null;
  private sim: RoundSimulation | null = null;
  private round = 0;
  private runActive = false;
  private runSeed = 1;
  private shapeRng: () => number = mulberry32(1);
  private recentShapes: ShapeId[] = [];
  private phaseT = 0;
  private acc = 0;
  private time = 0;
  private lastTs = 0;
  private raf = 0;
  private shake = 0;
  private simPenDown = false;
  private needle = { x: 0, y: 0, down: false, visible: false };
  private events: SimEvent[] = [];
  private wasOnCorridor = true;
  private lastWarnAt = 0;
  private dustT = 0;
  private resetArmedUntil = 0;
  private tutorialSeen = false;
  private resizeObs: ResizeObserver | null = null;
  private disposed = false;
  private pendingFailReason: 'broken' | 'timeout' | null = null;
  private roundAttempt = 0;
  private readonly onVisibility = () => this.handleVisibility(!document.hidden);
  private readonly onWindowResize = () => this.resize();

  constructor(container: HTMLElement) {
    this.ui = new UIController(container, {
      onAction: (a) => this.handleAction(a),
      onSetting: (k, v) => this.applySetting(k, v),
    });
    this.renderer = new CanvasRenderer(this.ui.canvas);
    this.input = new PointerInput(
      this.ui.canvas,
      () => ({ w: this.renderer.layout.w, h: this.renderer.layout.h }),
      (type, x, y, pt) => this.handlePointer(type, x, y, pt),
    );
    const s = this.storage.data.settings;
    this.audio.enabled = s.sound;
    this.platform.vibrationEnabled = s.vibration;
    this.renderer.effects = s.effects;
    this.renderer.particles.max = s.effects === 'high' ? 160 : 60;
    this.ui.updateSettings(s);
    this.ui.updateHome(this.storage.data);
    this.tutorialSeen = this.storage.data.gamesPlayed > 0;

    this.resize();
    this.showcase();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(this.ui.root);
    }
    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('orientationchange', this.onWindowResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.platform.init(
      () => this.handleBack(),
      (active) => this.handleVisibility(active),
    );
    this.ui.show('home');
    this.installDebugHook();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Read-only inspection hook used by the automated browser tests. */
  private installDebugHook(): void {
    (window as unknown as { __hcDebug?: unknown }).__hcDebug = {
      state: () => this.state,
      round: () => this.round,
      score: () => this.score.score,
      layout: () => ({ ...this.renderer.layout }),
      sim: () =>
        this.sim
          ? {
              shape: this.sim.contour.id,
              status: this.sim.status,
              coverage: this.sim.coverage,
              integrity: this.sim.cracks.integrity,
              cookieState: this.sim.cracks.state,
              cracks: this.sim.cracks.cracks.length,
              timeLeft: this.sim.timeLeft,
              required: this.sim.params.requiredCoverage,
            }
          : null,
      contourScreen: () => (this.sim ? this.sim.contour.points.map((p) => this.renderer.toScreen(p)) : []),
      showcase: (id: ShapeId, seed = 99) => this.renderer.prepareRound(getContour(id), seed),
      shapes: () => SHAPES.map((s) => s.id),
      coins: () => this.storage.data.totalCoins,
      continueRun: () => this.continueRun(),
    };
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    delete (window as unknown as { __hcDebug?: unknown }).__hcDebug;
    this.resizeObs?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('orientationchange', this.onWindowResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.input.destroy();
    this.audio.destroy();
    this.platform.destroy();
    this.ui.destroy();
  }

  // ------------------------------------------------------------ lifecycle

  private resize(): void {
    const r = this.ui.root.getBoundingClientRect();
    const w = Math.round(r.width) || window.innerWidth;
    const h = Math.round(r.height) || window.innerHeight;
    const L = this.renderer.layout;
    if (w === L.w && h === L.h) return;
    this.renderer.resize(w, h);
    if (!this.needle.down) this.restNeedle();
  }

  private restNeedle(): void {
    const L = this.renderer.layout;
    this.needle.x = L.cx + L.R * 0.42;
    this.needle.y = L.cy + L.R * 0.8;
    this.renderer.resetNeedle(this.needle.x, this.needle.y);
  }

  private showcase(): void {
    this.sim = null;
    this.renderer.prepareRound(getContour('umbrella'), 20240607);
    this.needle.visible = false;
  }

  private handleVisibility(active: boolean): void {
    if (!active) {
      this.pause();
      this.audio.suspend();
    } else {
      this.audio.resume();
      this.lastTs = 0;
    }
  }

  private handleBack(): void {
    switch (this.state) {
      case 'intro':
      case 'playing':
      case 'success':
        this.pause();
        break;
      case 'paused':
        this.resume();
        break;
      case 'tutorial':
      case 'settings':
      case 'collection':
        this.goHome();
        break;
      case 'gameover':
        this.finalizeRun(this.pendingFailReason ?? 'broken');
        this.pendingFailReason = null;
        this.goHome();
        break;
      case 'home':
        this.platform.exitApp();
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ actions

  private handleAction(action: string): void {
    this.audio.unlock();
    this.audio.click();
    switch (action) {
      case 'play':
        if (this.state !== 'home') return;
        if (!this.tutorialSeen) {
          this.state = 'tutorial';
          this.ui.show('tutorial');
        } else this.startRun();
        break;
      case 'tutorial':
        if (this.state !== 'home') return;
        this.state = 'tutorial';
        this.ui.show('tutorial');
        break;
      case 'settings':
        if (this.state !== 'home') return;
        this.state = 'settings';
        this.ui.confirmReset(false);
        this.ui.show('settings');
        break;
      case 'collection':
        if (this.state !== 'home') return;
        this.state = 'collection';
        this.ui.showCollection(this.storage.data.discovered, this.storage.data.bestRounds);
        this.ui.show('collection');
        break;
      case 'back':
        if (this.state === 'tutorial' || this.state === 'settings' || this.state === 'collection') this.goHome();
        break;
      case 'start':
        if (this.state !== 'tutorial') return;
        this.tutorialSeen = true;
        this.startRun();
        break;
      case 'pause':
        this.pause();
        break;
      case 'resume':
        this.resume();
        break;
      case 'restart':
        if (this.state !== 'paused') return;
        this.finalizeRun('quit');
        this.startRun();
        break;
      case 'continue-level':
        if (this.state !== 'gameover') return;
        this.continueRun();
        break;
      case 'retry':
        if (this.state !== 'gameover') return;
        this.finalizeRun(this.pendingFailReason ?? 'broken');
        this.pendingFailReason = null;
        this.startRun();
        break;
      case 'home':
        if (this.state === 'paused') {
          this.finalizeRun('quit');
          this.goHome();
        } else if (this.state === 'gameover') {
          this.finalizeRun(this.pendingFailReason ?? 'broken');
          this.pendingFailReason = null;
          this.goHome();
        }
        break;
      case 'reset-progress': {
        if (this.state !== 'settings') return;
        const now = performance.now();
        if (now < this.resetArmedUntil) {
          this.storage.resetProgress();
          this.resetArmedUntil = 0;
          this.ui.confirmReset(false);
          this.ui.updateHome(this.storage.data);
          this.ui.toast('Progress reset');
        } else {
          this.resetArmedUntil = now + 3000;
          this.ui.confirmReset(true);
          window.setTimeout(() => {
            if (performance.now() >= this.resetArmedUntil) this.ui.confirmReset(false);
          }, 3100);
        }
        break;
      }
    }
  }

  private applySetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.storage.updateSettings({ [key]: value } as Partial<Settings>);
    const s = this.storage.data.settings;
    this.audio.setEnabled(s.sound);
    this.platform.vibrationEnabled = s.vibration;
    this.renderer.setEffects(s.effects);
    this.ui.updateSettings(s);
    this.audio.click();
    if (key === 'vibration' && value) this.platform.impact('light');
  }

  private goHome(): void {
    this.state = 'home';
    this.pausedFrom = null;
    this.input.cancel();
    this.simPenDown = false;
    this.needle.down = false;
    this.audio.setScratch(0, false);
    this.ui.hideBanner();
    this.ui.setHudVisible(false);
    this.ui.updateHome(this.storage.data);
    this.showcase();
    this.ui.show('home');
  }

  private startRun(): void {
    this.score.startRun();
    this.round = 0;
    this.runSeed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    this.shapeRng = mulberry32(this.runSeed);
    this.recentShapes = [];
    this.runActive = true;
    this.pausedFrom = null;
    this.pendingFailReason = null;
    this.roundAttempt = 0;
    this.ui.show('none');
    this.ui.setHudVisible(true);
    this.nextRound();
  }

  private nextRound(): void {
    this.roundAttempt = 0;
    const params = DifficultyManager.params(this.round);
    const id = DifficultyManager.pickShape(params, this.shapeRng, this.recentShapes);
    this.recentShapes.push(id);
    if (this.recentShapes.length > 14) this.recentShapes.shift();
    const contour = getContour(id);
    const seed = hashString(`${id}:${this.round}:${this.runSeed}:${this.roundAttempt}`);
    const token = `${this.runSeed}:${this.round}:${this.roundAttempt}`;
    this.sim = new RoundSimulation(contour, params, seed, token);
    this.renderer.prepareRound(contour, seed);
    this.input.cancel();
    this.simPenDown = false;
    this.needle.down = false;
    this.needle.visible = true;
    this.restNeedle();
    this.wasOnCorridor = true;
    this.state = 'intro';
    this.phaseT = 0;
    this.acc = 0;
    const tolFrac = (params.tolerance - 0.065) / (0.15 - 0.065);
    this.ui.showIntro(this.round + 1, contour.name, this.sim.timeLimit, tolFrac);
    this.audio.roundStart();
  }

  private pause(): void {
    if (this.state !== 'intro' && this.state !== 'playing' && this.state !== 'success') return;
    this.pausedFrom = this.state;
    this.state = 'paused';
    this.sim?.cancelInput();
    this.input.cancel();
    this.simPenDown = false;
    this.needle.down = false;
    this.audio.setScratch(0, false);
    const tl = this.sim ? Math.ceil(this.sim.timeLeft) : 0;
    this.ui.setPauseInfo(`Round ${this.round + 1} · ${this.score.score.toLocaleString('en-US')} pts · ${tl}s left`);
    this.ui.show('pause');
  }

  private resume(): void {
    if (this.state !== 'paused' || !this.pausedFrom) return;
    this.state = this.pausedFrom;
    this.pausedFrom = null;
    this.acc = 0;
    this.lastTs = 0;
    this.ui.show('none');
  }

  /** Records the run once. Returns whether a new best was set. */
  private finalizeRun(reason: 'broken' | 'timeout' | 'quit'): { isBest: boolean } {
    if (!this.runActive) return { isBest: false };
    this.runActive = false;
    const failedAcc = this.sim && this.sim.status !== 'success' && this.sim.tracker.totalLen > 0.3 ? this.sim.tracker.accuracy : undefined;
    const summary = this.score.summary(failedAcc);
    const isBest = this.storage.recordRun(summary, reason);
    return { isBest };
  }

  private gameOver(reason: 'broken' | 'timeout'): void {
    if (this.state === 'gameover') return;
    this.pendingFailReason = reason;
    const failedAcc = this.sim && this.sim.tracker.totalLen > 0.3 ? this.sim.tracker.accuracy : undefined;
    const summary = this.score.summary(failedAcc);

    // Save best progress immediately so personal record is updated
    const d = this.storage.data;
    const isNewBest = summary.score > d.bestScore;
    if (isNewBest) d.bestScore = summary.score;
    if (summary.rounds > d.bestRounds) d.bestRounds = summary.rounds;
    if (isNewBest || summary.rounds > d.bestRounds) this.storage.save();

    this.state = 'gameover';
    this.needle.visible = false;
    this.audio.setScratch(0, false);
    this.ui.setHudVisible(false);
    this.ui.hideBanner();

    this.ui.showGameOver({
      reason,
      score: summary.score,
      best: d.bestScore,
      isNewBest,
      rounds: summary.rounds,
      currentRound: this.round + 1,
      accuracy: summary.accuracy,
      coins: summary.coins,
      totalCoins: d.totalCoins,
      bestStreak: summary.bestStreak,
      canContinue: d.totalCoins >= CONTINUE_COST,
      continueCost: CONTINUE_COST,
    });
  }

  private continueRun(): void {
    if (this.state !== 'gameover') return;
    if (this.storage.data.totalCoins < CONTINUE_COST) {
      this.ui.toast(`Need ${CONTINUE_COST} coins to continue!`);
      this.audio.fail();
      return;
    }
    const spent = this.storage.spendCoins(CONTINUE_COST);
    if (!spent) return;

    this.pendingFailReason = null;
    this.audio.unlock();
    this.audio.roundStart();
    this.platform.impact('medium');
    this.platform.notify('success');
    this.ui.toast(`Level ${this.round + 1} Continued! -${CONTINUE_COST} Coins`);

    this.retryCurrentRound();
  }

  private retryCurrentRound(): void {
    this.roundAttempt++;
    const params = DifficultyManager.params(this.round);
    const id = this.sim ? this.sim.contour.id : DifficultyManager.pickShape(params, this.shapeRng, this.recentShapes);
    const contour = getContour(id);
    const seed = hashString(`${id}:${this.round}:${this.runSeed}:${this.roundAttempt}`);
    const token = `${this.runSeed}:${this.round}:${this.roundAttempt}`;
    this.sim = new RoundSimulation(contour, params, seed, token);
    this.renderer.prepareRound(contour, seed);
    this.input.cancel();
    this.simPenDown = false;
    this.needle.down = false;
    this.needle.visible = true;
    this.restNeedle();
    this.wasOnCorridor = true;
    this.state = 'intro';
    this.phaseT = 0;
    this.acc = 0;
    const tolFrac = (params.tolerance - 0.065) / (0.15 - 0.065);
    this.ui.show('none');
    this.ui.setHudVisible(true);
    this.ui.showIntro(this.round + 1, contour.name, this.sim.timeLimit, tolFrac);
    this.audio.roundStart();
  }

  // ------------------------------------------------------------ input

  private handlePointer(type: PointerKind, x: number, y: number, pointerType: string): void {
    if (type === 'down') this.audio.unlock();
    const offset = this.storage.data.settings.needleOffset && pointerType !== 'mouse' ? NEEDLE_OFFSET_PX : 0;
    const px = x;
    const py = y - offset;
    const inRound = this.state === 'intro' || this.state === 'playing';
    if (inRound) {
      this.needle.x = px;
      this.needle.y = py;
    }
    if (type === 'hover') return;
    if (this.state !== 'playing' || !this.sim) {
      this.needle.down = false;
      return;
    }
    const n = this.renderer.toNormalized(px, py);
    if (type === 'up') {
      this.needle.down = false;
      if (this.simPenDown) this.sim.push({ type: 'up', x: n.x, y: n.y });
      this.simPenDown = false;
      return;
    }
    this.needle.down = true;
    if (type === 'down' || !this.simPenDown) {
      this.sim.push({ type: 'down', x: n.x, y: n.y });
      this.simPenDown = true;
    } else {
      this.sim.push({ type: 'move', x: n.x, y: n.y });
    }
  }

  // ------------------------------------------------------------ loop

  private frame(ts: number): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = this.lastTs ? Math.min(0.1, Math.max(0, (ts - this.lastTs) / 1000)) : 1 / 60;
    this.lastTs = ts;
    this.time += dt;
    this.update(dt);
    this.draw(dt);
  }

  private update(dt: number): void {
    const sim = this.sim;
    switch (this.state) {
      case 'intro':
        this.phaseT += dt;
        if (this.phaseT >= INTRO_TIME) {
          this.state = 'playing';
          this.phaseT = 0;
          this.acc = 0;
          // A finger already resting on the screen becomes the first sample.
          if (this.input.isDown && sim) {
            const n = this.renderer.toNormalized(this.needle.x, this.needle.y);
            sim.push({ type: 'down', x: n.x, y: n.y });
            this.simPenDown = true;
            this.needle.down = true;
          }
        }
        break;
      case 'playing': {
        if (!sim) break;
        this.acc += dt;
        let steps = 0;
        while (this.acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME && sim.status === 'playing') {
          this.events.length = 0;
          sim.step(SIM_DT, this.events);
          this.handleSimEvents(this.events);
          this.acc -= SIM_DT;
          steps++;
        }
        if (steps >= MAX_STEPS_PER_FRAME) this.acc = 0;
        if (sim.status !== 'playing') this.onRoundEnd(sim);
        else this.updateFeedback(dt, sim);
        break;
      }
      case 'success':
        this.phaseT += dt;
        if (this.phaseT >= SUCCESS_TIME) {
          this.round++;
          this.nextRound();
        }
        break;
      case 'breaking':
        this.phaseT += dt;
        if (this.phaseT >= BREAK_TIME) this.gameOver('broken');
        break;
      case 'timeout':
        this.phaseT += dt;
        if (this.phaseT >= TIMEOUT_TIME) this.gameOver('timeout');
        break;
      default:
        break;
    }
    this.shake *= Math.exp(-dt * 9);
    if (this.shake < 0.05) this.shake = 0;
  }

  private handleSimEvents(events: SimEvent[]): void {
    for (const e of events) {
      if (e.type === 'crack' || e.type === 'crackGrow') {
        const sev = e.severity ?? 0;
        const grow = e.type === 'crackGrow';
        this.renderer.burstCrumbs({ x: e.x ?? 0, y: e.y ?? 0 }, grow ? 4 : 7 + Math.round(sev * 8), grow ? 0.8 : 1);
        this.audio.crack(grow ? sev * 0.7 : sev);
        this.platform.impact(sev > 0.5 ? 'medium' : 'light');
        this.shake = Math.min(7, this.shake + (grow ? 2 : 3 + sev * 4));
      } else if (e.type === 'tick') {
        this.audio.tick((e.value ?? 5) <= 3);
      }
    }
  }

  private onRoundEnd(sim: RoundSimulation): void {
    this.simPenDown = false;
    this.needle.down = false;
    this.audio.setScratch(0, false);
    this.phaseT = 0;
    if (sim.status === 'success') {
      this.state = 'success';
      const reward = this.score.awardRound(sim.token, {
        round: this.round,
        accuracy: sim.tracker.accuracy,
        timeLeft: sim.timeLeft,
        timeLimit: sim.timeLimit,
        integrityFrac: sim.cracks.integrityFrac,
      });
      if (reward) {
        const isNewDesign = this.storage.bankRound(reward.coins, sim.contour.id);
        this.ui.showSuccess(reward, sim.contour.name, isNewDesign);
      }
      this.audio.success();
      this.platform.notify('success');
      this.renderer.sparkleContour(sim.contour, 36);
    } else if (sim.status === 'broken') {
      this.state = 'breaking';
      this.renderer.startBreak(sim.cracks.lastStressPos, hashString(sim.token));
      this.renderer.burstCrumbs(sim.cracks.lastStressPos, 34, 1.7);
      this.audio.breakCookie();
      this.platform.impact('heavy');
      this.platform.notify('error');
      this.shake = 8;
      this.ui.showFailBanner('broken');
    } else {
      this.state = 'timeout';
      this.audio.fail();
      this.platform.notify('error');
      this.ui.showFailBanner('timeout');
    }
  }

  private updateFeedback(dt: number, sim: RoundSimulation): void {
    const down = this.simPenDown && sim.tracker.penIsDown;
    const on = sim.tracker.onCorridor;
    this.audio.setScratch(down ? Math.min(1, sim.speed / 2) : 0, down && !on);
    if (down && !on && this.wasOnCorridor && this.time - this.lastWarnAt > 0.6) {
      this.lastWarnAt = this.time;
      this.platform.impact('light');
    }
    this.wasOnCorridor = !down || on;
    if (down && sim.cracks.state === 'severe') {
      this.shake = Math.max(this.shake, 0.5 + sim.cracks.strain * 1.6);
    }
    // Fine sugar dust when carving cleanly.
    if (down && on && sim.speed > 0.3) {
      this.dustT += dt;
      if (this.dustT > (this.renderer.effects === 'high' ? 0.07 : 0.18)) {
        this.dustT = 0;
        this.renderer.particles.crumbs(this.needle.x, this.needle.y, 1, 0.35 * this.renderer.layout.k);
      }
    }
  }

  private draw(dt: number): void {
    const sim = this.sim;
    const inRun = this.state !== 'home' && this.state !== 'tutorial' && this.state !== 'settings' && this.state !== 'collection' && this.state !== 'gameover';
    let phase: RenderPhase = 'idle';
    let phaseT = this.phaseT;
    const st = this.state === 'paused' ? this.pausedFrom : this.state;
    if (st === 'intro') phase = 'intro';
    else if (st === 'playing') phase = 'playing';
    else if (st === 'success') phase = 'success';
    else if (st === 'breaking') phase = 'breaking';
    else if (st === 'timeout') phase = 'timeout';
    else if (this.state === 'gameover' && sim) {
      phase = sim.status === 'broken' ? 'breaking' : sim.status === 'timeout' ? 'timeout' : 'idle';
      phaseT = 10;
    }
    if (this.state === 'paused' && st === 'intro') phaseT = INTRO_TIME;

    this.renderer.render({
      dt,
      time: this.time,
      phase,
      phaseT,
      contour: sim?.contour ?? null,
      tracker: sim?.tracker ?? null,
      cracks: sim?.cracks ?? null,
      needle: {
        x: this.needle.x,
        y: this.needle.y,
        down: this.needle.down && this.state === 'playing',
        visible: this.needle.visible && inRun && this.state !== 'breaking',
        onPath: sim ? sim.tracker.onCorridor : true,
        strain: sim ? sim.cracks.strain : 0,
      },
      shake: this.shake,
    });

    if (inRun && sim) {
      let hint = '';
      let level: 'ok' | 'warn' | 'bad' | 'idle' = 'idle';
      if (this.state === 'intro') {
        hint = 'Get ready…';
      } else if (this.state === 'playing') {
        const down = this.simPenDown && sim.tracker.penIsDown;
        if (!down) {
          hint = sim.coverage < 0.01 ? 'Press and trace the engraved outline' : 'Continue tracing the untouched line';
        } else if (!sim.tracker.onCorridor) {
          hint = 'Off the line!';
          level = 'bad';
        } else if (sim.speed > sim.params.safeSpeed) {
          hint = 'Too fast — ease the needle';
          level = 'warn';
        } else if (sim.cracks.strain > 0.3) {
          hint = 'Careful…';
          level = 'warn';
        }
      }
      this.ui.updateHud({
        round: this.round + 1,
        shapeName: sim.contour.name,
        score: this.score.score,
        timeLeft: sim.timeLeft,
        timeLimit: sim.timeLimit,
        integrityFrac: sim.cracks.integrityFrac,
        cookieState: sim.cracks.state,
        coverage: sim.coverage,
        required: sim.params.requiredCoverage,
        streak: this.score.streak,
        hint,
        hintLevel: level,
      });
    }
  }
}
