'use strict';
/**
 * One-shot local verification gate.
 *
 * Starts the real server in-process on a throwaway port, exercises the full
 * request matrix, checks the security posture and the model-credential surface,
 * then exits non-zero if anything failed. Run: `node scripts/verify.js`
 */

const http = require('node:http');
const path = require('node:path');
const { loadEnv } = require('../src/env');
loadEnv();
process.env.DISABLE_LLM = '1';

const { server } = require('../server');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function req(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body ? Buffer.from(opts.body) : null;
    const headers = { ...(opts.headers || {}) };
    if (body) headers['content-length'] = String(body.length);
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('agent-arena verification\n────────────────────────');
  // 1. modules load and parse
  const modules = ['../src/world', '../src/run', '../src/orchestrator', '../src/baseline', '../src/agents', '../src/llm', '../src/memory', '../src/scenarios'];
  let modulesOk = true;
  for (const m of modules) {
    try {
      require(m);
    } catch (err) {
      modulesOk = false;
      console.log(`      module ${m} failed: ${err.message}`);
    }
  }
  check('all server modules load', modulesOk);

  const port = 4500 + Math.floor(Math.random() * 300);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const home = await req(port, '/');
  check('GET / returns the command centre', home.status === 200 && home.body.includes('Agent Arena'), `${home.status}, ${home.body.length} bytes`);
  const js = await req(port, '/app.js');
  check('GET /app.js served', js.status === 200 && js.body.length > 5000, `${js.status}, ${js.body.length} bytes`);
  const css = await req(port, '/styles.css');
  check('GET /styles.css served', css.status === 200 && css.body.length > 2000, `${css.status}, ${css.body.length} bytes`);
  check('CSP + nosniff headers present', /default-src 'self'/.test(home.headers['content-security-policy'] || '') && home.headers['x-content-type-options'] === 'nosniff');

  const health = await req(port, '/api/health');
  const healthJson = JSON.parse(health.body);
  check('GET /api/health', health.status === 200 && healthJson.ok === true, `commit ${healthJson.commit}`);
  const scenarios = JSON.parse((await req(port, '/api/scenarios')).body);
  check('GET /api/scenarios lists 3 seeded markets + held-out', scenarios.scenarios.length === 3 && Boolean(scenarios.heldOut));

  const created = await req(port, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'steady-growth', mode: 'baseline', speedMs: 0 })
  });
  const { runId } = JSON.parse(created.body);
  check('POST /api/runs starts a run', created.status === 201 && Boolean(runId), runId);

  // let it finish (baseline is deterministic and fast)
  for (let i = 0; i < 60; i += 1) {
    const snap = JSON.parse((await req(port, `/api/runs/${encodeURIComponent(runId)}`)).body);
    if (snap.state.status === 'finished' || snap.state.status === 'bankrupt') break;
    await sleep(250);
  }
  const snap = JSON.parse((await req(port, `/api/runs/${encodeURIComponent(runId)}`)).body);
  check('run reaches day 90 and finishes', snap.state.day === 90 && snap.state.status === 'finished', `day ${snap.state.day}, ${snap.state.status}`);
  check('equity and cash are finite', Number.isFinite(snap.state.equity) && Number.isFinite(snap.state.cash), `equity ${snap.state.equity}`);

  const fin = JSON.parse((await req(port, `/api/runs/${encodeURIComponent(runId)}/financials`)).body);
  const balanced = Math.abs(fin.pnl.revenue - fin.pnl.cogs - fin.pnl.opex - fin.pnl.netProfit) < 0.02;
  check('P&L identity holds (revenue - cogs - opex = net)', balanced, `net ${fin.pnl.netProfit}`);
  check('operating cost breakdown adds up', Math.abs(Object.values(fin.pnl.opexBreakdown).reduce((a, b) => a + b, 0) - fin.pnl.opex) < 0.05);

  const ledger = JSON.parse((await req(port, `/api/runs/${encodeURIComponent(runId)}/ledger?limit=400`)).body);
  const unbalanced = ledger.entries.filter((e) => Math.abs(e.lines.reduce((s, l) => s + l.debit, 0) - e.lines.reduce((s, l) => s + l.credit, 0)) > 0.005);
  check('every served ledger entry is balanced', unbalanced.length === 0, `${ledger.entries.length} entries`);

  const audit = JSON.parse((await req(port, `/api/runs/${encodeURIComponent(runId)}/audit?limit=50`)).body);
  check('audit log is populated', audit.entries.length > 5, `${audit.count} entries`);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await req(port, `/api/runs/${encodeURIComponent(runId)}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cash: 999999 })
    });
    check(`${method} state mutation refused with 403`, r.status === 403, String(r.status));
  }
  const after = JSON.parse((await req(port, `/api/runs/${encodeURIComponent(runId)}`)).body);
  check('balances unchanged after the mutation attempts', after.state.cash !== 999999);

  check('unknown route is a clean 404', (await req(port, '/api/nope')).status === 404);
  check('static path traversal refused', [403, 404].includes((await req(port, '/../package.json')).status));

  const key = process.env.DEEPSEEK_API_KEY;
  let leaked = false;
  for (const p of ['/', '/app.js', '/styles.css', '/api/health', '/api/scenarios']) {
    const body = (await req(port, p)).body;
    if (key && key.length > 8 && body.includes(key)) leaked = true;
    if (/sk-[A-Za-z0-9]{20,}/.test(body)) leaked = true;
  }
  check('model credential absent from every public response', !leaked);
  check('DISABLE_LLM is respected', JSON.parse((await req(port, '/api/health')).body).model.enabled === false);

  await new Promise((resolve) => server.close(resolve));

  const failed = results.filter((r) => !r.ok);
  console.log('────────────────────────');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join(' | '));
    process.exit(1);
  }
  console.log('VERDICT: PASS');
  process.exit(0);
})().catch((err) => {
  console.error('verification crashed:', err);
  process.exit(2);
});
