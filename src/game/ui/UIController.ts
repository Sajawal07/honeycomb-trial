import type { RoundReward } from '../core/ScoreManager';
import { DifficultyManager } from '../core/DifficultyManager';
import { SHAPES, getContour } from '../core/ShapeFactory';
import type { CookieState } from '../core/types';
import type { SaveData, Settings } from '../services/StorageManager';

export type Screen = 'home' | 'tutorial' | 'settings' | 'collection' | 'pause' | 'gameover' | 'none';

export interface UIHandlers {
  onAction: (action: string) => void;
  onSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export interface HudData {
  round: number;
  shapeName: string;
  score: number;
  timeLeft: number;
  timeLimit: number;
  integrityFrac: number;
  cookieState: CookieState;
  coverage: number;
  required: number;
  streak: number;
  hint: string;
  hintLevel: 'ok' | 'warn' | 'bad' | 'idle';
}

export interface GameOverData {
  reason: 'broken' | 'timeout';
  score: number;
  best: number;
  isNewBest: boolean;
  rounds: number;
  currentRound: number;
  accuracy: number;
  coins: number;
  totalCoins: number;
  bestStreak: number;
  canContinue: boolean;
  continueCost: number;
}

const ICON = {
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/></svg>',
  coin: '<svg viewBox="0 0 24 24" aria-hidden="true" class="hc-coin"><circle cx="12" cy="12" r="9" fill="url(#hcCoinG)"/><circle cx="12" cy="12" r="6.2" fill="none" stroke="rgba(90,55,10,.55)" stroke-width="1.2"/><path d="M12 8.2l1.2 2.5 2.7.4-2 1.9.5 2.7L12 14.4l-2.4 1.3.5-2.7-2-1.9 2.7-.4z" fill="rgba(90,55,10,.6)"/></svg>',
  needle: '<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="hcSteel" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#666"/><stop offset=".35" stop-color="#f4f4f4"/><stop offset="1" stop-color="#3a3a3a"/></linearGradient></defs><g transform="rotate(-50 32 32)"><path d="M4 32 L14 30.6 L44 30.6 L44 33.4 L14 33.4 Z" fill="url(#hcSteel)"/><rect x="43" y="29" width="3.2" height="6" fill="#d9b25c"/><rect x="46" y="28.2" width="15" height="7.6" rx="3.8" fill="#5a341f"/></g></svg>',
};

function fmtTime(s: number): string {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function fmtNum(n: number): string {
  return Math.floor(n).toLocaleString('en-US');
}

const STATE_LABEL: Record<CookieState, string> = {
  intact: 'Intact',
  light: 'Light cracks',
  severe: 'Severe cracks',
  broken: 'Broken',
};

/**
 * UIController — DOM menus, HUD and overlays. All buttons use data-action
 * attributes routed through one delegated listener.
 */
export class UIController {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private el: Record<string, HTMLElement> = {};
  private screens: Record<string, HTMLElement> = {};
  private hudCache: Record<string, string> = {};
  private bannerTimer = 0;
  private toastTimer = 0;
  private onClick: (e: Event) => void;

  constructor(container: HTMLElement, handlers: UIHandlers) {
    const root = document.createElement('div');
    root.className = 'hc-root';
    root.innerHTML = this.template();
    container.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector('canvas.hc-canvas') as HTMLCanvasElement;
    root.querySelectorAll<HTMLElement>('[data-ref]').forEach((n) => (this.el[n.dataset.ref!] = n));
    root.querySelectorAll<HTMLElement>('[data-screen]').forEach((n) => (this.screens[n.dataset.screen!] = n));
    this.onClick = (e: Event) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action],[data-setting]');
      if (!target || !root.contains(target)) return;
      if (target.dataset.setting) {
        const key = target.dataset.setting as keyof Settings;
        const val = target.dataset.value;
        if (key === 'effects') handlers.onSetting('effects', val === 'low' ? 'low' : 'high');
        else handlers.onSetting(key, target.getAttribute('aria-checked') !== 'true');
        return;
      }
      if ((target as HTMLButtonElement).disabled) return;
      handlers.onAction(target.dataset.action!);
    };
    root.addEventListener('click', this.onClick);
  }

  private template(): string {
    return `
<svg width="0" height="0" style="position:absolute"><defs><radialGradient id="hcCoinG" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#fff1b8"/><stop offset=".5" stop-color="#e2b04a"/><stop offset="1" stop-color="#8a5f17"/></radialGradient><radialGradient id="hcColG" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#f2bd62"/><stop offset=".55" stop-color="#d9922f"/><stop offset="1" stop-color="#9c5818"/></radialGradient></defs></svg>
<canvas class="hc-canvas" aria-label="Honeycomb cookie tracing area"></canvas>
<div class="hc-grain" aria-hidden="true"></div>

<header class="hc-hud" data-ref="hud" hidden>
  <div class="hc-hud-row">
    <button class="hc-icon-btn" data-action="pause" aria-label="Pause">${ICON.pause}</button>
    <div class="hc-hud-center">
      <div class="hc-hud-round" data-ref="hudRound">Round 1</div>
      <div class="hc-hud-shape" data-ref="hudShape">Circle</div>
    </div>
    <div class="hc-hud-score"><span class="hc-label">Score</span><span data-ref="hudScore">0</span></div>
  </div>
  <div class="hc-timer" data-ref="timerWrap">
    <div class="hc-timer-num" data-ref="timer">0:00</div>
    <div class="hc-bar hc-bar-time"><i data-ref="timerBar"></i></div>
  </div>
  <div class="hc-meters">
    <div class="hc-meter">
      <div class="hc-meter-head"><span>Integrity</span><b data-ref="integrityLabel">Intact</b></div>
      <div class="hc-bar hc-bar-integrity" data-ref="integrityWrap"><i data-ref="integrityBar"></i></div>
    </div>
    <div class="hc-meter">
      <div class="hc-meter-head"><span>Traced</span><b data-ref="coverageLabel">0%</b></div>
      <div class="hc-bar hc-bar-cover"><i data-ref="coverageBar"></i><em data-ref="coverageGoal"></em></div>
    </div>
  </div>
</header>

<div class="hc-hint" data-ref="hint" hidden></div>
<div class="hc-streak" data-ref="streak" hidden></div>
<div class="hc-banner" data-ref="banner" hidden></div>
<div class="hc-toast" data-ref="toast" hidden></div>

<section class="hc-screen hc-home" data-screen="home">
  <div class="hc-home-top">
    <div class="hc-coins-pill">${ICON.coin}<span data-ref="homeCoins">0</span></div>
  </div>
  <div class="hc-brand">
    <div class="hc-emblem"><img src="./app-icon.png" alt="Honeycomb Trial" class="hc-app-logo" /></div>
    <p class="hc-kicker">An endless needle trial</p>
    <h1 class="hc-title">Honeycomb<br/><span>Trial</span></h1>
    <p class="hc-sub">Carve the shape. Keep the candy whole. Survive.</p>
  </div>
  <div class="hc-best-card">
    <div><span class="hc-label">Best score</span><strong data-ref="homeBest">0</strong></div>
    <div><span class="hc-label">Best run</span><strong data-ref="homeBestRounds">0</strong></div>
    <div><span class="hc-label">Rounds total</span><strong data-ref="homeTotalRounds">0</strong></div>
  </div>
  <p class="hc-last" data-ref="homeLast"></p>
  <div class="hc-actions">
    <button class="hc-btn hc-btn-primary" data-action="play">Play Survival</button>
    <div class="hc-btn-row hc-btn-row-3">
      <button class="hc-btn" data-action="tutorial">How to Play</button>
      <button class="hc-btn" data-action="collection">Collection <small data-ref="homeDesigns">0/0</small></button>
      <button class="hc-btn" data-action="settings">Settings</button>
    </div>
  </div>
</section>

<section class="hc-screen hc-panel-screen" data-screen="tutorial" hidden>
  <div class="hc-panel">
    <h2>How to Play</h2>
    <ol class="hc-steps">
      <li><span class="hc-step-ico hc-ico-trace"></span><div><b>Trace the engraving</b><p>Press and drag the needle along the carved outline. Lift and continue anytime — only the line you actually trace counts.</p></div></li>
      <li><span class="hc-step-ico hc-ico-corridor"></span><div><b>Stay inside the groove</b><p>Straying off the line, scratching fast or jerking the needle stresses the candy and spreads cracks.</p></div></li>
      <li><span class="hc-step-ico hc-ico-integrity"></span><div><b>Watch integrity</b><p>Cracks lower integrity. At zero the cookie shatters and the run ends.</p></div></li>
      <li><span class="hc-step-ico hc-ico-clock"></span><div><b>Beat the clock</b><p>Trace the whole outline before time runs out. Each round gets tighter, faster and more fragile.</p></div></li>
    </ol>
    <div class="hc-actions">
      <button class="hc-btn hc-btn-primary" data-action="start">Start Survival</button>
      <button class="hc-btn hc-btn-ghost" data-action="back">Back</button>
    </div>
  </div>
</section>

<section class="hc-screen hc-panel-screen" data-screen="collection" hidden>
  <div class="hc-panel hc-collection">
    <h2>Cookie Collection</h2>
    <p class="hc-panel-sub" data-ref="colSummary"></p>
    <div class="hc-col-progress"><i data-ref="colBar"></i></div>
    <div class="hc-col-grid" data-ref="colGrid" role="list"></div>
    <div class="hc-actions">
      <button class="hc-btn hc-btn-primary" data-action="back">Back</button>
    </div>
  </div>
</section>

<section class="hc-screen hc-panel-screen" data-screen="settings" hidden>
  <div class="hc-panel">
    <h2>Settings</h2>
    <div class="hc-setting"><div><b>Sound effects</b><p>Needle scratch, cracks and chimes</p></div><button class="hc-switch" role="switch" data-setting="sound" aria-checked="true" aria-label="Sound"><i></i></button></div>
    <div class="hc-setting"><div><b>Vibration</b><p>Haptic feedback on cracks and results</p></div><button class="hc-switch" role="switch" data-setting="vibration" aria-checked="true" aria-label="Vibration"><i></i></button></div>
    <div class="hc-setting"><div><b>Visual effects</b><p>Low saves battery on older phones</p></div>
      <div class="hc-seg"><button data-setting="effects" data-value="high">High</button><button data-setting="effects" data-value="low">Low</button></div></div>
    <div class="hc-setting"><div><b>Needle above finger</b><p>Offsets the needle tip so your finger never hides it</p></div><button class="hc-switch" role="switch" data-setting="needleOffset" aria-checked="false" aria-label="Needle offset"><i></i></button></div>
    <div class="hc-actions">
      <button class="hc-btn hc-btn-ghost hc-danger" data-action="reset-progress" data-ref="resetBtn">Reset progress</button>
      <button class="hc-btn hc-btn-primary" data-action="back">Done</button>
    </div>
  </div>
</section>

<section class="hc-screen hc-panel-screen" data-screen="pause" hidden>
  <div class="hc-panel hc-panel-compact">
    <h2>Paused</h2>
    <p class="hc-panel-sub" data-ref="pauseInfo"></p>
    <div class="hc-actions">
      <button class="hc-btn hc-btn-primary" data-action="resume">Resume</button>
      <button class="hc-btn" data-action="restart">Restart Run</button>
      <button class="hc-btn hc-btn-ghost" data-action="home">Home</button>
    </div>
  </div>
</section>

<section class="hc-screen hc-panel-screen" data-screen="gameover" hidden>
  <div class="hc-panel hc-gameover">
    <p class="hc-kicker" data-ref="goKicker">Run over</p>
    <h2 data-ref="goTitle">Cookie Cracked</h2>
    <div class="hc-go-score"><span data-ref="goScore">0</span><em class="hc-newbest" data-ref="goNewBest" hidden>New best</em></div>
    <div class="hc-stats">
      <div><span class="hc-label">Rounds survived</span><strong data-ref="goRounds">0</strong></div>
      <div><span class="hc-label">Accuracy</span><strong data-ref="goAccuracy">0%</strong></div>
      <div><span class="hc-label">Coins earned</span><strong class="hc-coin-val">${ICON.coin}<span data-ref="goCoins">0</span></strong></div>
      <div><span class="hc-label">Best score</span><strong data-ref="goBest">0</strong></div>
    </div>
    <p class="hc-panel-sub" data-ref="goExtra"></p>
    <div class="hc-actions">
      <button class="hc-btn hc-btn-primary hc-btn-continue" data-action="continue-level" data-ref="goContinueBtn">
        <span class="hc-btn-continue-main">${ICON.coin} <span data-ref="goContinueMain">Continue (50 Coins)</span></span>
        <span class="hc-btn-continue-sub" data-ref="goContinueSub">Resume run and keep your streak</span>
      </button>
      <div class="hc-btn-row">
        <button class="hc-btn" data-action="retry">Retry (New Run)</button>
        <button class="hc-btn hc-btn-ghost" data-action="home">Home</button>
      </div>
    </div>
  </div>
</section>`;
  }

  show(screen: Screen): void {
    for (const [name, node] of Object.entries(this.screens)) {
      const on = name === screen;
      if (on && node.hidden) {
        node.hidden = false;
        node.classList.remove('hc-enter');
        void node.offsetWidth;
        node.classList.add('hc-enter');
      } else if (!on) node.hidden = true;
    }
    this.root.dataset.screen = screen;
  }

  setHudVisible(on: boolean): void {
    this.el.hud.hidden = !on;
    if (!on) {
      this.el.hint.hidden = true;
      this.el.streak.hidden = true;
    }
  }

  updateHome(d: SaveData): void {
    this.el.homeCoins.textContent = fmtNum(d.totalCoins);
    this.el.homeBest.textContent = fmtNum(d.bestScore);
    this.el.homeBestRounds.textContent = `${d.bestRounds} rd${d.bestRounds === 1 ? '' : 's'}`;
    this.el.homeTotalRounds.textContent = fmtNum(d.totalRounds);
    this.el.homeDesigns.textContent = `${d.discovered.length}/${SHAPES.length}`;
    const lr = d.lastRun;
    this.el.homeLast.textContent = lr
      ? `Last run · ${fmtNum(lr.score)} pts · ${lr.rounds} rounds · ${Math.round(lr.accuracy * 100)}% accuracy`
      : 'No runs yet — your first cookie awaits.';
  }

  updateSettings(s: Settings): void {
    this.root.querySelectorAll<HTMLElement>('[data-setting]').forEach((n) => {
      const key = n.dataset.setting as keyof Settings;
      if (key === 'effects') {
        n.classList.toggle('is-on', n.dataset.value === s.effects);
        n.setAttribute('aria-pressed', String(n.dataset.value === s.effects));
      } else n.setAttribute('aria-checked', String(Boolean(s[key])));
    });
  }

  private setText(key: string, value: string): void {
    if (this.hudCache[key] === value) return;
    this.hudCache[key] = value;
    this.el[key].textContent = value;
  }

  private setStyle(key: string, prop: 'width' | 'left', value: string): void {
    const ck = `${key}.${prop}`;
    if (this.hudCache[ck] === value) return;
    this.hudCache[ck] = value;
    this.el[key].style[prop] = value;
  }

  private setClass(key: string, cls: string): void {
    const ck = `${key}.class`;
    if (this.hudCache[ck] === cls) return;
    this.hudCache[ck] = cls;
    this.el[key].dataset.state = cls;
  }

  updateHud(h: HudData): void {
    this.setText('hudRound', `Round ${h.round}`);
    this.setText('hudShape', h.shapeName);
    this.setText('hudScore', fmtNum(h.score));
    this.setText('timer', fmtTime(h.timeLeft));
    const tf = h.timeLimit > 0 ? h.timeLeft / h.timeLimit : 0;
    this.setStyle('timerBar', 'width', `${(tf * 100).toFixed(1)}%`);
    this.setClass('timerWrap', h.timeLeft <= 5.0 ? 'urgent' : h.timeLeft <= 10 ? 'warn' : 'ok');
    this.setStyle('integrityBar', 'width', `${(h.integrityFrac * 100).toFixed(1)}%`);
    this.setText('integrityLabel', `${STATE_LABEL[h.cookieState]} · ${Math.ceil(h.integrityFrac * 100)}%`);
    this.setClass('integrityWrap', h.cookieState);
    this.setClass('integrityLabel', h.cookieState);
    const cov = Math.min(1, h.coverage);
    this.setStyle('coverageBar', 'width', `${(cov * 100).toFixed(1)}%`);
    this.setStyle('coverageGoal', 'left', `${(h.required * 100).toFixed(1)}%`);
    this.setText('coverageLabel', `${Math.floor(cov * 100)}% / ${Math.round(h.required * 100)}%`);
    if (h.hint) {
      this.el.hint.hidden = false;
      this.setText('hint', h.hint);
      this.setClass('hint', h.hintLevel);
    } else this.el.hint.hidden = true;
    if (h.streak >= 2) {
      this.el.streak.hidden = false;
      this.setText('streak', `Clean streak ×${h.streak}`);
    } else this.el.streak.hidden = true;
  }

  private colBuilt = false;

  /** Renders the collection grid (SVG thumbnails are built once and cached). */
  showCollection(discovered: readonly string[], bestRounds: number): void {
    const grid = this.el.colGrid;
    if (!this.colBuilt) {
      this.colBuilt = true;
      const tiles = SHAPES.map((meta) => {
        const c = getContour(meta.id);
        const step = Math.max(1, Math.floor(c.points.length / 160));
        let d = '';
        for (let i = 0; i < c.points.length; i += step) {
          const p = c.points[i];
          d += `${i === 0 ? 'M' : 'L'}${(p.x * 74).toFixed(1)} ${(p.y * 74).toFixed(1)}`;
        }
        if (!c.closed) {
          const last = c.points[c.points.length - 1];
          d += `L${(last.x * 74).toFixed(1)} ${(last.y * 74).toFixed(1)}`;
        } else d += 'Z';
        const unlock = DifficultyManager.unlockRound(meta.complexity);
        const tier = meta.complexity < 1.5 ? 'Easy' : meta.complexity < 2.1 ? 'Medium' : 'Hard';
        return `<div class="hc-col-tile" role="listitem" data-shape="${meta.id}">
  <svg viewBox="-104 -104 208 208" aria-hidden="true"><circle class="hc-col-cookie" r="98"/><path class="hc-col-groove" d="${d}"/><path class="hc-col-line" d="${d}"/></svg>
  <b>${meta.name}</b><span class="hc-col-meta"><i class="hc-tier hc-tier-${tier.toLowerCase()}"></i>${tier} · R${unlock}</span></div>`;
      });
      grid.innerHTML = tiles.join('');
    }
    const found = new Set(discovered);
    grid.querySelectorAll<HTMLElement>('.hc-col-tile').forEach((t) => {
      const on = found.has(t.dataset.shape!);
      t.classList.toggle('is-found', on);
      t.setAttribute('aria-label', `${t.querySelector('b')!.textContent}: ${on ? 'extracted' : 'not extracted yet'}`);
    });
    const n = found.size;
    this.el.colSummary.textContent = `${n} of ${SHAPES.length} designs extracted · best run ${bestRounds} round${bestRounds === 1 ? '' : 's'}`;
    this.el.colBar.style.width = `${((n / SHAPES.length) * 100).toFixed(1)}%`;
  }

  showIntro(round: number, shapeName: string, timeLimit: number, tolerancePct: number): void {
    const level = tolerancePct > 0.75 ? 'Forgiving groove' : tolerancePct > 0.45 ? 'Narrow groove' : 'Razor groove';
    this.banner(
      `<p class="hc-kicker">Round ${round}</p><h3>${shapeName}</h3><p class="hc-banner-meta">${timeLimit}s · ${level}</p>`,
      'intro',
      1500,
    );
  }

  showSuccess(reward: RoundReward, shapeName: string, isNewDesign = false): void {
    const rows = [
      ['Extraction', reward.base],
      ['Accuracy bonus', reward.accuracyBonus],
      ['Time bonus', reward.timeBonus],
      ['Integrity bonus', reward.integrityBonus],
    ]
      .map(([k, v]) => `<li><span>${k}</span><b>+${fmtNum(v as number)}</b></li>`)
      .join('');
    const mult = reward.multiplier > 1 ? `<li class="hc-mult"><span>Clean streak ×${reward.streak}</span><b>×${reward.multiplier.toFixed(1)}</b></li>` : '';
    this.banner(
      `<p class="hc-kicker">${shapeName} extracted</p><h3 class="hc-gold">+${fmtNum(reward.total)}</h3><ul class="hc-breakdown">${rows}${mult}</ul><p class="hc-banner-coins">${ICON.coin}+${reward.coins}</p>${isNewDesign ? '<p class="hc-banner-new">New design added to your collection</p>' : ''}`,
      'success',
      2100,
    );
  }

  showFailBanner(reason: 'broken' | 'timeout'): void {
    this.banner(`<h3 class="hc-red">${reason === 'broken' ? 'Shattered' : "Time's up"}</h3>`, 'fail', 1400);
  }

  hideBanner(): void {
    window.clearTimeout(this.bannerTimer);
    this.el.banner.hidden = true;
  }

  private banner(html: string, kind: string, ms: number): void {
    const b = this.el.banner;
    window.clearTimeout(this.bannerTimer);
    b.innerHTML = html;
    b.dataset.kind = kind;
    b.hidden = false;
    b.classList.remove('hc-pop');
    void b.offsetWidth;
    b.classList.add('hc-pop');
    this.bannerTimer = window.setTimeout(() => (b.hidden = true), ms);
  }

  toast(msg: string): void {
    const t = this.el.toast;
    t.textContent = msg;
    t.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.hidden = true), 1800);
  }

  setPauseInfo(text: string): void {
    this.el.pauseInfo.textContent = text;
  }

  showGameOver(d: GameOverData): void {
    this.el.goKicker.textContent = d.reason === 'broken' ? 'The candy shattered' : 'The clock ran out';
    this.el.goTitle.textContent = d.reason === 'broken' ? 'Cookie Cracked' : "Time's Up";
    this.el.goScore.textContent = fmtNum(d.score);
    this.el.goNewBest.hidden = !d.isNewBest;
    this.el.goRounds.textContent = String(d.rounds);
    this.el.goAccuracy.textContent = `${Math.round(d.accuracy * 100)}%`;
    this.el.goCoins.textContent = `+${fmtNum(d.coins)}`;
    this.el.goBest.textContent = fmtNum(d.best);
    this.el.goExtra.textContent = `Best clean streak ×${d.bestStreak} · Wallet ${fmtNum(d.totalCoins)} coins`;
    const btn = this.el.goContinueBtn as HTMLButtonElement | undefined;
    if (btn) {
      if (d.canContinue) {
        btn.disabled = false;
        btn.classList.remove('is-disabled');
        this.el.goContinueMain.textContent = `Use ${d.continueCost} Coins to Continue`;
        this.el.goContinueSub.textContent = `Resume Level ${d.currentRound} · Wallet has ${fmtNum(d.totalCoins)} coins`;
      } else {
        btn.disabled = true;
        btn.classList.add('is-disabled');
        this.el.goContinueMain.textContent = `Need ${d.continueCost} Coins to Continue`;
        this.el.goContinueSub.textContent = `Wallet has ${fmtNum(d.totalCoins)} / ${d.continueCost} coins`;
      }
    }
    this.show('gameover');
  }

  confirmReset(armed: boolean): void {
    this.el.resetBtn.textContent = armed ? 'Tap again to confirm' : 'Reset progress';
    this.el.resetBtn.classList.toggle('is-armed', armed);
  }

  destroy(): void {
    window.clearTimeout(this.bannerTimer);
    window.clearTimeout(this.toastTimer);
    this.root.removeEventListener('click', this.onClick);
    this.root.remove();
  }
}
