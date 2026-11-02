'use strict';
/**
 * Agent Arena command-centre server.
 *
 * Zero runtime dependencies: node:http + static files + JSON API + Server-Sent
 * Events. The simulation loop is driven here one day at a time so the UI can
 * pause, resume, single-step and reset a live run.
 *
 * Security posture:
 * - the model credential is read from the environment and never serialised;
 *   /api/health exposes only whether the model is enabled and its name.
 * - no route accepts a balance, inventory, price or ledger mutation from a
 *   client. State changes flow only through the engine's typed actions.
 * - strict CSP, nosniff, frame-deny, a 64 KB body cap and a naive rate limit.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnv } = require('./src/env');
loadEnv();

const { SimulationRun, RunStore } = require('./src/run');
const { SEEDED_SCENARIOS, BASE_CONFIG } = require('./src/scenarios');
const { PRICE_TABLE } = require('./src/llm');

const PORT = Number(process.env.PORT || 4000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.APP_COMMIT || 'local-dev';
const store = new RunStore(DATA_DIR);
const startedAt = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const slot = {
  run: null,
  paused: false,
  speedMs: Number(process.env.SPEED_MS || 120),
  clients: new Set(),
  loop: null,
  stopping: false
};

const rate = new Map();

/**
 * Older saved runs predate financials in the snapshot. Their KPIs are still engine
 * numbers, so the statement is rebuilt from them rather than left blank.
 */
function deriveFinancials(saved) {
  const k = saved.kpis || {};
  const days = (saved.state && saved.state.days) || [];
  return {
    balances: { cash: k.finalCash, inventory: k.avgInventoryValue, receivable: (saved.state && saved.state.receivables) || 0, equity: k.finalEquity },
    pnl: {
      revenue: k.revenue,
      cogs: k.cogs,
      grossProfit: k.grossProfit,
      grossMarginPct: k.grossMarginPct,
      opex: k.opex,
      opexBreakdown: null,
      netProfit: k.netProfit,
      netMarginPct: k.revenue ? Math.round((k.netProfit / k.revenue) * 10000) / 100 : 0
    },
    cashflow: days.map((d, i) => ({ day: d.day, cash: d.cash, change: i === 0 ? null : Math.round((d.cash - days[i - 1].cash) * 100) / 100 })),
    ledgerEntries: null,
    losses: { lostUnits: k.lostUnits, lostRevenue: k.lostRevenue, stockoutDays: k.stockoutDays },
    derived: true
  };
}

function rateLimited(ip) {
  const now = Date.now();
  // Prune idle buckets so a long-lived process cannot grow this map without bound.
  if (rate.size > 500) {
    for (const [key, hits] of rate) {
      if (!hits.length || now - hits[hits.length - 1] > 60000) rate.delete(key);
    }
  }
  const bucket = rate.get(ip) || [];
  const recent = bucket.filter((t) => now - t < 10000);
  recent.push(now);
  rate.set(ip, recent);
  return recent.length > 80;
}

/**
 * Trusted client identity for the rate limiter. On Render the socket peer is the proxy,
 * so X-Forwarded-For is honoured only when TRUST_PROXY=1, and then only its RIGHTMOST hop
 * (a client can prepend forged hops on the left, never append to the right).
 */
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const header = req.headers['x-forwarded-for'];
    if (typeof header === 'string' && header.length) {
      const hops = header.split(',').map((h) => h.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  securityHeaders(res);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  securityHeaders(res);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // Keep draining so the client gets a clean 413 instead of a reset socket,
        // but stop buffering attacker-controlled bytes.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('body too large'), { status: 413 }));
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of slot.clients) {
    try {
      res.write(frame);
    } catch (e) {
      slot.clients.delete(res);
    }
  }
}

function lifecycle(event, data) {
  broadcast(event, data);
}

async function startRun({ scenarioId, mode, seed, speedMs }) {
  if (slot.run) {
    slot.stopping = true;
    if (slot.loop) await Promise.race([slot.loop, sleep(3000)]);
  }
  const run = new SimulationRun({
    scenarioId,
    mode,
    seed,
    onEvent: () => {},
    // Interactive runs get a unique id so a demo never overwrites a saved benchmark run.
    options: { runId: `${scenarioId}__${mode}__live-${Date.now().toString(36)}` }
  });
  slot.run = run;
  slot.paused = false;
  slot.stopping = false;
  slot.speedMs = Number.isFinite(speedMs) ? speedMs : slot.speedMs;
  const mySlot = run.runId;
  slot.loop = pump(mySlot).catch((err) => {
    console.error('simulation loop error:', err && err.message);
    lifecycle('error', { message: 'simulation halted on an internal error; see server log' });
  });
  return run;
}

async function pump(runId) {
  let lastSave = 0;
  while (slot.run && slot.run.runId === runId && !slot.stopping) {
    const run = slot.run;
    if (['finished', 'bankrupt', 'failed'].includes(run.status)) break;
    if (slot.paused) {
      await sleep(150);
      continue;
    }
    try {
      await run.step();
    } catch (err) {
      lifecycle('error', { message: String(err.message).slice(0, 300) });
      break;
    }
    const now = Date.now();
    if (now - lastSave > 1500) {
      lastSave = now;
      try {
        store.save(run);
        store.appendAudit(run);
      } catch (e) {
        /* persistence must never kill the run */
      }
    }
    broadcast('state', run.snapshot({ decisionsLimit: 40 }));
    if (slot.speedMs > 0) await sleep(slot.speedMs);
  }
  const run = slot.run;
  if (run && run.runId === runId) {
    try {
      store.save(run);
      store.appendAudit(run);
    } catch (e) {
      /* ignore */
    }
    broadcast('done', run.snapshot({ decisionsLimit: 120 }));
    lifecycle('done', { runId, status: run.status, day: run.day });
  }
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return text(res, 403, 'forbidden');
  fs.readFile(full, (err, data) => {
    if (err) return text(res, 404, 'not found');
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    securityHeaders(res);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = clientIp(req);
  if (rateLimited(ip)) return json(res, 429, { error: 'rate limited' });

  try {
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      securityHeaders(res);
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const llmEnabled = Boolean(process.env.DEEPSEEK_API_KEY) && !process.env.DISABLE_LLM;
      return json(res, 200, {
        ok: true,
        service: 'agent-arena',
        commit: COMMIT,
        node: process.version,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        model: { name: process.env.AGENT_MODEL || 'deepseek-flash', enabled: llmEnabled, thinking: process.env.AGENT_THINKING || 'off' },
        prices: PRICE_TABLE['deepseek-flash']
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/scenarios') {
      return json(res, 200, {
        scenarios: SEEDED_SCENARIOS.map((s) => ({
          id: s.id,
          name: s.name,
          difficulty: s.difficulty,
          headline: s.headline,
          seed: s.seed,
          days: BASE_CONFIG.days,
          decisionCadence: BASE_CONFIG.decisionCadence
        })),
        heldOut: { id: 'heldout', name: 'Evaluator Held-Out (generated at run time)' },
        policy: BASE_CONFIG.policy,
        economics: {
          initialCapital: BASE_CONFIG.initialCapital,
          rentPerDay: BASE_CONFIG.rentPerDay,
          salariesPerDay: BASE_CONFIG.salariesPerDay,
          outboundUnitCost: BASE_CONFIG.outboundUnitCost,
          expediteUnitCost: BASE_CONFIG.expediteUnitCost,
          elasticity: BASE_CONFIG.elasticity
        }
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/eval') {
      const file = path.join(DATA_DIR, 'eval-report.json');
      if (!fs.existsSync(file)) return json(res, 200, { scenarios: [], message: 'no evaluation report yet' });
      return json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
    }

    if (req.method === 'GET' && url.pathname === '/api/runs') {
      return json(res, 200, { runs: store.list().slice(0, 25), active: slot.run ? slot.run.runId : null });
    }

    if (req.method === 'POST' && url.pathname === '/api/runs') {
      const body = await readBody(req);
      const scenarioId = String(body.scenarioId || SEEDED_SCENARIOS[0].id);
      const mode = body.mode === 'baseline' ? 'baseline' : 'ai';
      const valid = SEEDED_SCENARIOS.some((s) => s.id === scenarioId) || scenarioId === 'heldout';
      if (!valid) return json(res, 400, { error: `unknown scenario ${scenarioId}` });
      const speedMs = [0, 60, 150, 400].includes(Number(body.speedMs)) ? Number(body.speedMs) : slot.speedMs;
      const run = await startRun({ scenarioId, mode, speedMs });
      return json(res, 201, { runId: run.runId, mode: run.mode, scenario: run.scenario.id });
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(\/.*)?$/);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      const sub = runMatch[2] || '';
      const isActive = slot.run && slot.run.runId === runId;
      const source = isActive ? slot.run : null;
      const saved = !source ? store.read(runId) : null;
      if (!source && !saved) return json(res, 404, { error: 'run not found' });

      if (req.method === 'GET' && (sub === '' || sub === '/')) {
        if (source) return json(res, 200, { ...source.snapshot({ decisionsLimit: 120 }), live: true, paused: slot.paused, speedMs: slot.speedMs });
        return json(res, 200, { ...saved, live: false });
      }

      if (req.method === 'GET' && sub === '/financials') {
        if (source) return json(res, 200, source.world.financials());
        return json(res, 200, saved.financials || deriveFinancials(saved));
      }

      if (req.method === 'GET' && sub === '/ledger') {
        if (!source) return json(res, 200, { entries: [], note: 'ledger is kept for live runs only' });
        const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
        return json(res, 200, { entries: source.world.state.ledger.slice(-limit), count: source.world.state.ledger.length });
      }

      if (req.method === 'GET' && sub === '/audit') {
        if (!source) return json(res, 200, { entries: [] });
        const limit = Math.min(500, Number(url.searchParams.get('limit') || 150));
        return json(res, 200, { entries: source.world.state.audit.slice(-limit), count: source.world.state.audit.length });
      }

      if (req.method === 'GET' && sub === '/stream') {
        if (!source) return json(res, 409, { error: 'run is not live' });
        securityHeaders(res);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive'
        });
        res.write(`event: state\ndata: ${JSON.stringify({ ...source.snapshot({ decisionsLimit: 40 }), live: true, paused: slot.paused })}\n\n`);
        slot.clients.add(res);
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch (e) {
            clearInterval(ping);
          }
        }, 15000);
        req.on('close', () => {
          clearInterval(ping);
          slot.clients.delete(res);
        });
        return undefined;
      }

      if (req.method === 'POST' && sub === '/control') {
        const body = await readBody(req);
        const action = String(body.action || '');
        if (!source) {
          if (action === 'reset') {
            const run = await startRun({ scenarioId: (saved && saved.scenario && saved.scenario.id) || SEEDED_SCENARIOS[0].id, mode: (saved && saved.mode) || 'ai', speedMs: slot.speedMs });
            return json(res, 201, { runId: run.runId });
          }
          return json(res, 409, { error: 'run is not live' });
        }
        if (action === 'pause') {
          slot.paused = true;
          lifecycle('control', { paused: true });
          return json(res, 200, { paused: true });
        }
        if (action === 'resume') {
          slot.paused = false;
          lifecycle('control', { paused: false });
          return json(res, 200, { paused: false });
        }
        if (action === 'step') {
          slot.paused = true;
          await source.step();
          store.save(source);
          broadcast('state', { ...source.snapshot({ decisionsLimit: 40 }), live: true, paused: true });
          return json(res, 200, { day: source.day, status: source.status, paused: true });
        }
        if (action === 'reset') {
          const run = await startRun({ scenarioId: source.scenario.id, mode: source.mode, speedMs: slot.speedMs });
          return json(res, 201, { runId: run.runId });
        }
        if (action === 'speed') {
          const ms = Math.max(0, Math.min(2000, Number(body.speedMs || 120)));
          slot.speedMs = ms;
          return json(res, 200, { speedMs: ms });
        }
        return json(res, 400, { error: `unknown control action ${action}` });
      }

      // Anything that would mutate balances, stock, prices or history directly is refused here,
      // and only here: the engine is the single writer.
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
        await readBody(req).catch(() => ({}));
        return json(res, 403, {
          error: 'direct state mutation is not permitted',
          detail: 'agents and clients may only submit typed proposals; the simulation engine applies them with policy checks and an audit trail'
        });
      }
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    return json(res, status, { error: String(err.message).slice(0, 200) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`agent-arena listening on http://localhost:${PORT} (commit ${COMMIT})`);
    console.log(`model: ${process.env.AGENT_MODEL || 'deepseek-flash'} thinking=${process.env.AGENT_THINKING || 'off'} enabled=${Boolean(process.env.DEEPSEEK_API_KEY) && !process.env.DISABLE_LLM}`);
  });
}

module.exports = { server, slot, startRun };
