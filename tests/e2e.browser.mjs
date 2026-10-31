/* End-to-end browser test (headless Chromium via Playwright).
 * Usage: npm run build && node tests/e2e.browser.mjs [path-to-playwright]
 * Plays real rounds through pointer events against dist/index.html. */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const pwPath = process.argv[2] || 'playwright';
const { chromium } = require(pwPath);
const url = 'file://' + path.resolve('dist/index.html');
const out = path.resolve('tests/screens');
fs.mkdirSync(out, { recursive: true });

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name} ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const errors = [];

async function newPage(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => !!window.__hcDebug);
  return { ctx, page };
}

const dbg = (page, expr) => page.evaluate(expr);

async function traceCurrent(page, { stopAt = 1.1, stride = 3, wiggle = 0 } = {}) {
  const pts = await dbg(page, () => window.__hcDebug.contourScreen());
  const n = pts.length;
  const total = Math.floor(n * stopAt);
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (let i = stride; i <= total; i += stride) {
    const p = pts[i % n];
    const w = wiggle ? Math.sin(i * 0.05) * wiggle : 0;
    await page.mouse.move(p.x + w, p.y + w);
    await sleep(8);
    const st = await dbg(page, () => window.__hcDebug.state());
    if (st !== 'playing') break;
  }
  await page.mouse.up();
}

console.log('\nPhone 390x844 — full survival flow');
{
  const { ctx, page } = await newPage(390, 844);
  await sleep(400);
  await page.screenshot({ path: `${out}/01-home.png` });
  check('home screen visible', await page.isVisible('[data-screen="home"]'));

  await page.click('[data-action="play"]');
  check('first play shows tutorial', await page.isVisible('[data-screen="tutorial"]'));
  await page.screenshot({ path: `${out}/02-tutorial.png` });
  await page.click('[data-action="start"]');
  await sleep(1500);
  check('round 1 playing', (await dbg(page, () => window.__hcDebug.state())) === 'playing');
  await page.screenshot({ path: `${out}/03-round1.png` });

  // Incomplete trace must not succeed.
  await traceCurrent(page, { stopAt: 0.5 });
  await sleep(200);
  let sim = await dbg(page, () => window.__hcDebug.sim());
  check('half trace does not succeed', sim.status === 'playing', `cov=${(sim.coverage * 100).toFixed(1)}%`);
  await page.screenshot({ path: `${out}/04-half-traced.png` });

  // Pause / resume freezes the timer.
  await page.click('[data-action="pause"]');
  const t0 = (await dbg(page, () => window.__hcDebug.sim())).timeLeft;
  await sleep(700);
  const t1 = (await dbg(page, () => window.__hcDebug.sim())).timeLeft;
  check('pause freezes timer', Math.abs(t0 - t1) < 0.001 && (await page.isVisible('[data-screen="pause"]')));
  await page.click('[data-action="resume"]');
  await sleep(300);
  const t2 = (await dbg(page, () => window.__hcDebug.sim())).timeLeft;
  check('resume continues timer', t2 < t1 && (await dbg(page, () => window.__hcDebug.state())) === 'playing');

  // Complete the trace.
  await traceCurrent(page, { stopAt: 1.12 });
  await sleep(250);
  check('full trace -> success', (await dbg(page, () => window.__hcDebug.state())) === 'success');
  await page.screenshot({ path: `${out}/05-success.png` });
  const score1 = await dbg(page, () => window.__hcDebug.score());
  check('score awarded', score1 > 0, `score=${score1}`);
  // Hammer taps during success: must not duplicate rewards.
  for (let i = 0; i < 10; i++) await page.mouse.click(195, 450);
  await sleep(2300);
  const score2 = await dbg(page, () => window.__hcDebug.score());
  check('repeated taps do not duplicate rewards', score2 === score1);
  check('advanced to round 2', (await dbg(page, () => window.__hcDebug.round())) === 1);
  await sleep(1400);

  // Round 2: trace partly off the line to create cracks, then scribble to break.
  await traceCurrent(page, { stopAt: 0.45, wiggle: 40 });
  await sleep(300);
  sim = await dbg(page, () => window.__hcDebug.sim());
  check('deviation produces cracks', sim.cracks > 0 && sim.integrity < 100, `cracks=${sim.cracks} integ=${sim.integrity.toFixed(1)} state=${sim.cookieState}`);
  await page.screenshot({ path: `${out}/06-cracks.png` });
  const L = await dbg(page, () => window.__hcDebug.layout());
  await page.mouse.move(L.cx, L.cy);
  await page.mouse.down();
  for (let i = 0; i < 400; i++) {
    await page.mouse.move(L.cx + Math.sin(i * 0.5) * L.R * 0.5, L.cy + Math.cos(i * 0.37) * L.R * 0.5);
    await sleep(10);
    const st = await dbg(page, () => window.__hcDebug.state());
    if (st !== 'playing') break;
  }
  await page.mouse.up();
  check('scribbling breaks the cookie', (await dbg(page, () => window.__hcDebug.state())) === 'breaking');
  await sleep(350);
  await page.screenshot({ path: `${out}/07-breaking.png` });
  await sleep(1700);
  check('game over screen shown', await page.isVisible('[data-screen="gameover"]'));
  await page.screenshot({ path: `${out}/08-gameover.png` });
  const goRounds = await page.textContent('[data-ref="goRounds"]');
  const goScore = await page.textContent('[data-ref="goScore"]');
  check('game over stats correct', goRounds === '1' && goScore.replace(/,/g, '') === String(score1), `rounds=${goRounds} score=${goScore}`);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('honeycomb-trial.save.v1')));
  check('best score & coins persisted', saved.bestScore === score1 && saved.totalCoins > 0 && saved.totalRounds === 1);
  check('extracted design recorded', Array.isArray(saved.discovered) && saved.discovered.length === 1, JSON.stringify(saved.discovered));

  // Retry: clean run, best preserved.
  await page.click('[data-action="retry"]');
  await page.click('[data-action="retry"]').catch(() => {});
  await sleep(200);
  check('retry starts clean run', (await dbg(page, () => window.__hcDebug.score())) === 0 && (await dbg(page, () => window.__hcDebug.round())) === 0);
  const saved2 = await page.evaluate(() => JSON.parse(localStorage.getItem('honeycomb-trial.save.v1')));
  check('retry keeps saved best', saved2.bestScore === score1);

  // Backgrounding auto-pauses.
  await sleep(1400);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check('backgrounding pauses the game', (await dbg(page, () => window.__hcDebug.state())) === 'paused');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check('returning stays paused until Resume', (await dbg(page, () => window.__hcDebug.state())) === 'paused');
  await page.click('[data-action="home"]');
  await sleep(200);

  // Reload: persistence.
  await page.reload();
  await page.waitForFunction(() => !!window.__hcDebug);
  const best = await page.textContent('[data-ref="homeBest"]');
  check('best score shown after restart', best.replace(/,/g, '') === String(score1), `best=${best}`);
  await page.click('[data-action="collection"]');
  await sleep(150);
  const tiles = await page.$$eval('.hc-col-tile', (n) => n.length);
  const found = await page.$$eval('.hc-col-tile.is-found', (n) => n.length);
  check(`collection lists ${tiles} designs, ${found} extracted`, tiles >= 20 && found === 1);
  await page.screenshot({ path: `${out}/10-collection.png` });
  await page.click('section[data-screen="collection"] [data-action="back"]');
  await page.click('[data-action="settings"]');
  await page.click('[data-setting="sound"]');
  await page.screenshot({ path: `${out}/09-settings.png` });
  await page.reload();
  await page.waitForFunction(() => !!window.__hcDebug);
  const soundOn = await page.getAttribute('[data-setting="sound"]', 'aria-checked');
  check('settings persist', soundOn === 'false');

  // Corrupted storage handled safely.
  await page.evaluate(() => localStorage.setItem('honeycomb-trial.save.v1', '{"bestScore":"abc",'));
  await page.reload();
  await page.waitForFunction(() => !!window.__hcDebug);
  check('corrupted save falls back safely', (await page.textContent('[data-ref="homeBest"]')) === '0');
  await ctx.close();
}

console.log('\nShape rendering contact sheets');
for (const [w, h] of [
  [360, 640],
  [412, 915],
  [800, 1280],
]) {
  const { ctx, page } = await newPage(w, h);
  await page.addStyleTag({ content: '.hc-screen{display:none!important}' });
  const ids = await dbg(page, () => window.__hcDebug.shapes());
  const sheet = await page.evaluate(async (ids) => {
    const c = document.querySelector('canvas.hc-canvas');
    const L = window.__hcDebug.layout();
    const cols = 7;
    const rows = Math.ceil(ids.length / cols);
    const crop = L.R * 2.5 * L.dpr;
    const sx = (L.cx - L.R * 1.25) * L.dpr;
    const sy = (L.cy - L.R * 1.25) * L.dpr;
    const tile = 220;
    const out = document.createElement('canvas');
    out.width = tile * cols;
    out.height = tile * rows;
    const g = out.getContext('2d');
    for (let i = 0; i < ids.length; i++) {
      window.__hcDebug.showcase(ids[i], 1000 + i * 8);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      g.drawImage(c, sx, sy, crop, crop, (i % cols) * tile, Math.floor(i / cols) * tile, tile, tile);
    }
    return out.toDataURL('image/png');
  }, ids);
  fs.writeFileSync(`${out}/shapes-${w}x${h}.png`, Buffer.from(sheet.split(',')[1], 'base64'));
  check(`all ${ids.length} designs rendered at ${w}x${h}`, ids.length >= 20 && sheet.length > 10000);
  await ctx.close();
}

check('no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
