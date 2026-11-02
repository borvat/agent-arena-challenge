'use strict';
/**
 * Browser evidence: screenshots of the command centre in both languages and a
 * phone viewport, plus an axe-core accessibility scan.
 *
 * Runs against a model-free server (DISABLE_LLM=1) reading saved benchmark runs,
 * so a screenshot is reproducible without spending a token.
 *
 *   node scripts/browser-evidence.js [runId]
 */

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = 4181;
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SPEED_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });
  await ready;

  const listing = await (await fetch(`${BASE}/api/runs`)).json();
  let runId = process.argv[2] || (listing.runs.find((r) => r.mode === 'ai' && r.status === 'finished') || {}).runId;

  // --fresh-ai starts a real model-backed 90-day run and screenshots that, so the
  // panels that only exist in a live run (audit tail, rolling cover, agent text) are real.
  if (process.argv.includes('--fresh-ai')) {
    const created = await (
      await fetch(`${BASE}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'steady-growth', mode: 'ai', speedMs: 0 })
      })
    ).json();
    runId = created.runId;
    process.stdout.write(`live run ${runId} `);
    for (let i = 0; i < 240; i += 1) {
      const snap = await (await fetch(`${BASE}/api/runs/${encodeURIComponent(runId)}`)).json();
      if (['finished', 'bankrupt', 'failed'].includes(snap.state.status)) break;
      await new Promise((r) => setTimeout(r, 1500));
      if (i % 10 === 0) process.stdout.write('.');
    }
    process.stdout.write('\n');
  }

  if (!runId) throw new Error('no finished AI run found; run scripts/evaluate.js first');
  const url = `${BASE}/?run=${encodeURIComponent(runId)}`;

  const browser = await chromium.launch();
  const errors = [];
  const shots = [];

  const shoot = async (name, viewport, lang) => {
    const context = await browser.newContext({ viewport, bypassCSP: true });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(url, { waitUntil: 'networkidle' });
    if (lang === 'en') {
      await page.click('#lang');
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(500);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    shots.push(file);
    return { page, context };
  };

  const desktop = await shoot('command-center-ar', { width: 1440, height: 1100 }, 'ar');
  const dir = await desktop.page.evaluate(() => document.documentElement.dir);
  await desktop.context.close();

  const english = await shoot('command-center-en', { width: 1440, height: 1100 }, 'en');
  const dirEn = await english.page.evaluate(() => document.documentElement.dir);
  const overflowDesktop = await english.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await english.context.close();

  const mobile = await shoot('command-center-mobile-ar', { width: 390, height: 844 }, 'ar');
  const overflowMobile = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await mobile.context.close();

  // axe-core: injected into a CSP-bypassing context, never by weakening the app's own CSP.
  const a11y = await shoot('a11y-check', { width: 1440, height: 1100 }, 'ar');
  await a11y.page.addScriptTag({ path: path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js') });
  const results = await a11y.page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] });
    return {
      violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })),
      passes: r.passes.length
    };
  });
  await a11y.context.close();

  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    url,
    dirAr: dir,
    dirEn,
    overflowDesktop,
    overflowMobile,
    consoleErrors: errors,
    accessibility: results,
    screenshots: shots.map((s) => path.relative(ROOT, s))
  };
  fs.writeFileSync(path.join(ROOT, 'docs', 'browser-evidence.json'), JSON.stringify(report, null, 2));

  console.log(`run: ${runId}`);
  console.log(`dir ar=${dir} en=${dirEn} | overflow desktop=${overflowDesktop}px mobile=${overflowMobile}px`);
  console.log(`console errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  console.log(`axe: ${results.violations.length} violation(s) over ${results.passes} passing rules`);
  for (const v of results.violations) console.log(`  [${v.impact}] ${v.id} (${v.nodes} node(s)) — ${v.help}`);
  console.log(`screenshots: ${report.screenshots.join(', ')}`);

  await browser.close();
  server.kill();
  const severe = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  if (errors.length || severe.length) {
    console.log('VERDICT: FAIL');
    process.exit(1);
  }
  console.log('VERDICT: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
