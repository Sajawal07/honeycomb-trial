/* Headless tests for the core game simulation (no DOM).
 * Run: npm run test:sim  (bundles with esbuild and executes in Node) */
import { SHAPES, getContour, validateContour, type Contour } from '../src/game/core/ShapeFactory';
import { RoundSimulation, SIM_DT } from '../src/game/core/RoundSimulation';
import { DifficultyManager } from '../src/game/core/DifficultyManager';
import { ScoreManager } from '../src/game/core/ScoreManager';
import { StorageManager } from '../src/game/services/StorageManager';
import { CONTINUE_COST } from '../src/game/GameEngine';
import { mulberry32 } from '../src/game/core/rng';
import type { SimEvent } from '../src/game/core/types';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name} ${detail}`);
  }
}

function makeSim(c: Contour, round: number, seed = 1234): RoundSimulation {
  return new RoundSimulation(c, DifficultyManager.params(round), seed, `t-${c.id}-${round}`);
}

/** Point at arc distance s along the contour (wraps for closed shapes). */
function pointAt(c: Contour, s: number, offset = 0): { x: number; y: number } {
  const n = c.points.length;
  let f = s / c.spacing;
  if (c.closed) f = ((f % n) + n) % n;
  else f = Math.max(0, Math.min(n - 1, f));
  const i = Math.floor(f);
  const j = c.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
  const t = f - i;
  const a = c.points[i];
  const b = c.points[j];
  const nm = c.normals[i];
  return { x: a.x + (b.x - a.x) * t + nm.x * offset, y: a.y + (b.y - a.y) * t + nm.y * offset };
}

interface RunOpts {
  speed: number;
  jitter: number; // fraction of tolerance
  offset?: number; // fraction of tolerance, constant normal offset
  maxLenFrac?: number; // stop tracing after this fraction of the length
  seed?: number;
}

function traceRun(c: Contour, round: number, o: RunOpts) {
  const sim = makeSim(c, round, o.seed ?? 99);
  const tol = sim.params.tolerance;
  const rng = mulberry32(42);
  const events: SimEvent[] = [];
  let s = 0;
  const limit = c.length * (o.maxLenFrac ?? 1.08);
  sim.push({ type: 'down', ...pointAt(c, 0) });
  let steps = 0;
  while (sim.status === 'playing' && steps < 60 * 120) {
    if (s < limit) {
      s += o.speed * SIM_DT;
      // Smooth hand wobble (low frequency) + small touch-sensor noise (~1.5px).
      const wobble = o.jitter * tol * (0.6 * Math.sin(s * 7 + 1.3) + 0.4 * Math.sin(s * 17 + 0.4));
      const noise = (rng() - 0.5) * 2 * 0.012;
      const j = wobble + noise + (o.offset ?? 0) * tol;
      sim.push({ type: 'move', ...pointAt(c, s, j) });
    } else if (steps % 600 === 0) {
      sim.push({ type: 'up', x: 0, y: 0 });
    }
    sim.step(SIM_DT, events);
    steps++;
  }
  return { sim, events };
}

console.log('\nShape validation');
for (const meta of SHAPES) {
  const c = getContour(meta.id);
  const v = validateContour(c);
  check(`${meta.id}: valid contour (${c.points.length} pts, clearance ${v.minClearance.toFixed(3)})`, v.ok, v.issues.join('; '));
}

console.log('\nAccurate tracing succeeds without damage (rounds 0, 4, 10, 25)');
for (const meta of SHAPES) {
  for (const round of [0, 4, 10, 25]) {
    const c = getContour(meta.id);
    const { sim } = traceRun(c, round, { speed: 1.3, jitter: 0.35 });
    check(
      `${meta.id} r${round}: success, integrity ${sim.cracks.integrity.toFixed(1)}/${sim.params.integrity.toFixed(0)}, cov ${(sim.coverage * 100).toFixed(1)}%, acc ${(sim.tracker.accuracy * 100).toFixed(0)}%`,
      sim.status === 'success' && sim.cracks.cracks.length === 0,
      `status=${sim.status}`,
    );
  }
}

console.log('\nIncomplete tracing cannot succeed');
for (const id of ['circle', 'star', 'spiral'] as const) {
  const c = getContour(id);
  const { sim } = traceRun(c, 0, { speed: 1.3, jitter: 0.2, maxLenFrac: 0.8 });
  check(`${id}: 80% traced -> ${sim.status} (cov ${(sim.coverage * 100).toFixed(1)}%)`, sim.status === 'timeout');
}

console.log('\nTapping cannot generate coverage');
{
  const c = getContour('circle');
  const sim = makeSim(c, 0);
  const ev: SimEvent[] = [];
  for (let k = 0; k < 400; k++) {
    const p = pointAt(c, (k * 0.37) % c.length);
    sim.push({ type: 'down', ...p });
    sim.step(SIM_DT, ev);
    sim.push({ type: 'up', ...p });
    sim.step(SIM_DT, ev);
  }
  check(`400 taps -> coverage ${(sim.coverage * 100).toFixed(1)}%`, sim.coverage < 0.05 && sim.status !== 'success');
}

console.log('\nTeleporting between sections gives no credit');
{
  const c = getContour('star');
  const sim = makeSim(c, 0);
  const ev: SimEvent[] = [];
  sim.push({ type: 'down', ...pointAt(c, 0) });
  // Big jumps along the contour within one held stroke (between samples).
  for (let k = 1; k < 200 && sim.status === 'playing'; k++) {
    sim.push({ type: 'move', ...pointAt(c, k * 0.9) });
    sim.step(SIM_DT * 10, ev);
  }
  check(`teleport moves -> coverage ${(sim.coverage * 100).toFixed(1)}%, status ${sim.status}`, sim.status !== 'success');
}

console.log('\nShortcut across the cookie is not credited and causes stress');
{
  const c = getContour('circle');
  const sim = makeSim(c, 0);
  const ev: SimEvent[] = [];
  const half = c.length / 2;
  let s = 0;
  sim.push({ type: 'down', ...pointAt(c, 0) });
  while (s < half) {
    s += 1.3 * SIM_DT;
    sim.push({ type: 'move', ...pointAt(c, s) });
    sim.step(SIM_DT, ev);
  }
  const covHalf = sim.coverage;
  const a = pointAt(c, half);
  const b = pointAt(c, 0);
  for (let k = 1; k <= 60; k++) {
    sim.push({ type: 'move', x: a.x + (b.x - a.x) * (k / 60), y: a.y + (b.y - a.y) * (k / 60) });
    sim.step(SIM_DT, ev);
  }
  check(
    `half trace ${(covHalf * 100).toFixed(1)}% + cut across -> ${(sim.coverage * 100).toFixed(1)}%, integrity ${sim.cracks.integrity.toFixed(1)}`,
    sim.coverage < 0.56 && sim.cracks.integrity < sim.params.integrity && sim.status !== 'success',
  );
}

console.log('\nDeviation produces cracks; severe abuse breaks the cookie');
{
  const c = getContour('heart');
  const { sim } = traceRun(c, 0, { speed: 1.0, jitter: 0.1, offset: 2.2, maxLenFrac: 0.6 });
  check(`2.2x tolerance offset -> cracks ${sim.cracks.cracks.length}, state ${sim.cracks.state}, status ${sim.status}`, sim.cracks.cracks.length > 0);
  const sim2 = makeSim(getContour('flower'), 5);
  const ev: SimEvent[] = [];
  let t = 0;
  sim2.push({ type: 'down', x: 0, y: 0 });
  while (sim2.status === 'playing' && t < 20) {
    t += SIM_DT;
    sim2.push({ type: 'move', x: Math.sin(t * 9) * 0.5, y: Math.cos(t * 7) * 0.5 });
    sim2.step(SIM_DT, ev);
  }
  check(`scribbling -> ${sim2.status} after ${t.toFixed(2)}s, break event ${ev.some((e) => e.type === 'break')}`, sim2.status === 'broken' && t < 6);
}

console.log('\nFast tracing on the line builds stress');
{
  const c = getContour('circle');
  const { sim } = traceRun(c, 0, { speed: 9, jitter: 0.2 });
  check(`speed 9 u/s -> integrity ${sim.cracks.integrity.toFixed(1)}`, sim.cracks.integrity < sim.params.integrity);
}

console.log('\nDeterminism');
{
  const c = getContour('umbrella');
  const r1 = traceRun(c, 3, { speed: 1.4, jitter: 0.6, offset: 1.6, seed: 7 });
  const r2 = traceRun(c, 3, { speed: 1.4, jitter: 0.6, offset: 1.6, seed: 7 });
  const sig = (s: RoundSimulation) =>
    `${s.status}|${s.cracks.integrity.toFixed(6)}|${s.cracks.segmentCount}|${s.cracks.cracks.map((k) => k.segments.map((g) => g.x2.toFixed(5)).join(',')).join(';')}`;
  check(`identical inputs -> identical outcome (${r1.sim.status}, ${r1.sim.cracks.segmentCount} segs)`, sig(r1.sim) === sig(r2.sim));
}

console.log('\nTimer');
{
  const c = getContour('circle');
  const sim = makeSim(c, 0);
  const ev: SimEvent[] = [];
  let steps = 0;
  while (sim.status === 'playing' && steps < 100000) {
    sim.step(SIM_DT, ev);
    steps++;
  }
  check(`idle -> timeout after ${(steps * SIM_DT).toFixed(2)}s (limit ${sim.timeLimit}s)`, sim.status === 'timeout' && Math.abs(steps * SIM_DT - sim.timeLimit) < 0.05);
  check(`5 countdown ticks emitted`, ev.filter((e) => e.type === 'tick').length === 5);
}

console.log('\nDifficulty progression');
{
  let mono = true;
  for (let r = 1; r < 60; r++) {
    const a = DifficultyManager.params(r - 1);
    const b = DifficultyManager.params(r);
    if (!(b.tolerance <= a.tolerance && b.baseTime <= a.baseTime && b.integrity <= a.integrity && b.sensitivity >= a.sensitivity && b.requiredCoverage >= a.requiredCoverage)) mono = false;
  }
  check('parameters harden monotonically', mono);
  const rng = mulberry32(5);
  const recent: ReturnType<typeof DifficultyManager.pickShape>[] = [];
  let repeat = false;
  let earlyComplex = false;
  const seen = new Set<string>();
  for (let r = 0; r < 80; r++) {
    const id = DifficultyManager.pickShape(DifficultyManager.params(r), rng, recent);
    if (id === recent[recent.length - 1]) repeat = true;
    if (r < 2 && getContour(id).complexity > 1.6) earlyComplex = true;
    recent.push(id);
    if (recent.length > 12) recent.shift();
    seen.add(id);
  }
  check('no immediate shape repeats, no complex shapes in first rounds', !repeat && !earlyComplex);
  check(`all ${SHAPES.length} designs appear within 80 rounds (${seen.size} seen)`, seen.size === SHAPES.length);
  check(`at least 20 designs available (${SHAPES.length})`, SHAPES.length >= 20);
  const ids = SHAPES.map((s) => s.id);
  check('design ids are unique', new Set(ids).size === ids.length);
  const lastUnlock = Math.max(...SHAPES.map((s) => DifficultyManager.unlockRound(s.complexity)));
  check(`every design unlocks by round ${lastUnlock}`, lastUnlock <= 12);
}

console.log('\nScoring');
{
  const sm = new ScoreManager();
  sm.startRun();
  const r = { round: 0, accuracy: 0.95, timeLeft: 20, timeLimit: 40, integrityFrac: 1 };
  const a = sm.awardRound('round-1', r);
  const b = sm.awardRound('round-1', r);
  check(`first award ${a?.total}, duplicate award ${b}`, a !== null && b === null && sm.rounds === 1);
  const c = sm.awardRound('round-2', { ...r, round: 1 });
  check(`streak multiplier grows (${a?.multiplier} -> ${c?.multiplier})`, !!c && !!a && c.multiplier > a.multiplier);
  sm.startRun();
  check('startRun resets run totals', sm.score === 0 && sm.rounds === 0 && sm.coins === 0);
}

console.log('\nCoins & Level Continue');
{
  const sm = new ScoreManager();
  sm.startRun();
  const storage = new StorageManager();
  storage.data.totalCoins = 20;

  check('CONTINUE_COST is 50 coins', CONTINUE_COST === 50);
  check('cannot continue when coins < 50', storage.spendCoins(CONTINUE_COST) === false && storage.data.totalCoins === 20);

  storage.bankRound(60);
  check('bankRound adds coins to totalCoins (20 + 60 = 80)', storage.data.totalCoins === 80);

  const spent = storage.spendCoins(CONTINUE_COST);
  check('spendCoins(50) succeeds when coins >= 50 (80 - 50 = 30)', spent === true && storage.data.totalCoins === 30);

  // Verify continue round awards tokens properly without collisions
  const r0 = { round: 0, accuracy: 0.95, timeLeft: 20, timeLimit: 40, integrityFrac: 1 };
  sm.awardRound('seed:0:0', r0); // First round cleared
  check('round 0 awarded', sm.rounds === 1);

  // Player reaches round 1, fails on attempt 0 (so seed:1:0 is never awarded).
  // They spend 50 coins to continue round 1 on attempt 1:
  const r1 = { round: 1, accuracy: 0.92, timeLeft: 15, timeLimit: 35, integrityFrac: 0.9 };
  const continuedReward = sm.awardRound('seed:1:1', r1);
  check('continued round 1 awards cleanly on attempt 1', continuedReward !== null && sm.rounds === 2);
  check('score accumulates across continued rounds', sm.score > (continuedReward?.total ?? 0));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
