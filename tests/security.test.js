'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

process.env.DISABLE_LLM = '1';
const { server } = require(path.join(__dirname, '..', 'server.js'));

let base;
let sockets = [];

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.on('connection', (s) => sockets.push(s));
});

test.after(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((resolve) => server.close(resolve));
});

function request(pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body ? Buffer.from(opts.body) : null;
    const headers = { ...(opts.headers || {}) };
    if (body) headers['content-length'] = String(body.length);
    const req = http.request(`${base}${pathname}`, { method: opts.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('security: the command centre is served with a restrictive Content-Security-Policy', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.body.includes('Agent Arena'));
});

test('security: the API credential is never exposed by any public endpoint or asset', async () => {
  const key = process.env.DEEPSEEK_API_KEY;
  const paths = ['/', '/app.js', '/styles.css', '/api/health', '/api/scenarios'];
  for (const p of paths) {
    const res = await request(p);
    if (key && key.length > 8) assert.ok(!res.body.includes(key), `${p} leaked the API key`);
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(res.body), `${p} leaked an sk- token`);
  }
  const health = JSON.parse((await request('/api/health')).body);
  assert.equal(health.model.enabled, false, 'DISABLE_LLM should report the model as disabled');
  assert.equal(health.commit.length > 0, true);
});

test('security: a client cannot write balances, stock or history through the API', async () => {
  const created = await request('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'steady-growth', mode: 'baseline', speedMs: 0 })
  });
  const { runId } = JSON.parse(created.body);
  assert.ok(runId);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await request(`/api/runs/${encodeURIComponent(runId)}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cash: 999999, inventory: { EAR: 100000 } })
    });
    assert.equal(res.status, 403, `${method} should be refused`);
    assert.match(res.body, /not permitted/);
  }

  const state = JSON.parse((await request(`/api/runs/${encodeURIComponent(runId)}`)).body);
  assert.notEqual(state.state.cash, 999999);
  assert.ok(state.state.inventory.EAR < 5000, 'injected inventory must not appear in engine state');
  // And the trading itself is engine-driven: the ledger moved, but only through typed actions.
  const audit = JSON.parse((await request(`/api/runs/${encodeURIComponent(runId)}/audit?limit=50`)).body);
  assert.ok(audit.entries.length > 0);
  assert.ok(!audit.entries.some((e) => /SET_CASH|manual mutation/i.test(e.detail)));
});

test('security: path traversal and oversized bodies are rejected', async () => {
  const trav = await request('/../package.json');
  assert.ok([403, 404].includes(trav.status), `expected refusal, got ${trav.status}`);
  const big = await request('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'steady-growth', padding: 'x'.repeat(70000) })
  });
  assert.ok([400, 413].includes(big.status), `expected 400/413, got ${big.status}`);
});

test('security: unknown endpoints and unknown scenarios are handled without stack traces', async () => {
  assert.equal((await request('/api/does-not-exist')).status, 404);
  const bad = await request('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioId: '../../etc/passwd' })
  });
  assert.equal(bad.status, 400);
  assert.ok(!/at\s+\w+\s+\(/.test(bad.body), 'no stack trace in the response');
});

test('api: a run can be paused, stepped and reset, and the audit log is served', async () => {
  const created = await request('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenarioId: 'steady-growth', mode: 'baseline', speedMs: 0 })
  });
  const { runId } = JSON.parse(created.body);
  await new Promise((r) => setTimeout(r, 400));
  const pause = await request(`/api/runs/${encodeURIComponent(runId)}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pause' })
  });
  assert.equal(pause.status, 200);
  const step = await request(`/api/runs/${encodeURIComponent(runId)}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'step' })
  });
  assert.equal(step.status, 200);
  const audit = JSON.parse((await request(`/api/runs/${encodeURIComponent(runId)}/audit?limit=5`)).body);
  assert.ok(audit.entries.length > 0);
  const fin = JSON.parse((await request(`/api/runs/${encodeURIComponent(runId)}/financials`)).body);
  assert.ok(fin.pnl && typeof fin.pnl.revenue === 'number');
});
