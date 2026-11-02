'use strict';
/* Agent Arena command centre — vanilla JS, no build step. */

const DICT = {
  'app.title': { ar: 'Agent Arena', en: 'Agent Arena' },
  'app.subtitle': { ar: 'شركة تجارة افتراضية يديرها ستة وكلاء', en: 'A virtual trading company run by six agents' },
  'controls.scenario': { ar: 'السوق', en: 'Market' },
  'controls.mode': { ar: 'الوضع', en: 'Mode' },
  'controls.start': { ar: 'ابدأ التشغيل', en: 'Start run' },
  'controls.pause': { ar: 'إيقاف مؤقت', en: 'Pause' },
  'controls.resume': { ar: 'متابعة', en: 'Resume' },
  'controls.step': { ar: 'يوم واحد', en: 'Step 1 day' },
  'controls.reset': { ar: 'إعادة تعيين', en: 'Reset' },
  'mode.ai': { ar: 'شركة الوكلاء', en: 'AI agent company' },
  'mode.baseline': { ar: 'الخط الأساسي', en: 'Deterministic baseline' },
  'dash.capital': { ar: 'رأس المال والتدفق النقدي', en: 'Capital & cash flow' },
  'dash.market': { ar: 'السوق والأحداث', en: 'Market & events' },
  'dash.policy': { ar: 'حدود السياسة', en: 'Policy limits' },
  'dash.agents': { ar: 'الوكلاء', en: 'Agents' },
  'dash.timeline': { ar: 'قرارات المجلس', en: 'Decision timeline' },
  'dash.inventory': { ar: 'المخزون', en: 'Inventory' },
  'dash.suppliers': { ar: 'الموردون', en: 'Suppliers' },
  'dash.purchaseOrders': { ar: 'أوامر الشراء', en: 'Purchase orders' },
  'dash.audit': { ar: 'سجل التدقيق', en: 'Audit log' },
  'dash.eval': { ar: 'مقارنة التقييم', en: 'Evaluation comparison' },
  'footer.note': { ar: 'محاكاة مالية بالكامل: لا مشتريات ولا تحويلات حقيقية.', en: 'Fully simulated: no real purchases, emails or transfers.' },
  'kpi.equity': { ar: 'حقوق الملكية', en: 'Equity' },
  'kpi.cash': { ar: 'النقد', en: 'Cash' },
  'kpi.revenue': { ar: 'الإيراد', en: 'Revenue' },
  'kpi.margin': { ar: 'هامش الربح الإجمالي', en: 'Gross margin' },
  'kpi.fill': { ar: 'نسبة التلبية', en: 'Fill rate' },
  'kpi.inventory': { ar: 'قيمة المخزون', en: 'Inventory value' },
  'kpi.runway': { ar: 'مدى النقد (يوم)', en: 'Cash runway (d)' },
  'kpi.violations': { ar: 'مخالفات ورفض', en: 'Violations / blocks' },
  'fin.revenue': { ar: 'الإيراد', en: 'Revenue' },
  'fin.cogs': { ar: 'تكلفة المبيعات', en: 'COGS' },
  'fin.gross': { ar: 'الربح الإجمالي', en: 'Gross profit' },
  'fin.opex': { ar: 'المصروفات التشغيلية', en: 'Operating costs' },
  'fin.net': { ar: 'صافي الربح', en: 'Net profit' },
  'fin.receivables': { ar: 'ذمم مدينة', en: 'Receivables' },
  'th.sku': { ar: 'المنتج', en: 'SKU' },
  'th.onhand': { ar: 'المتاح', en: 'On hand' },
  'th.inbound': { ar: 'قادم', en: 'Inbound' },
  'th.cover': { ar: 'التغطية (يوم)', en: 'Cover (d)' },
  'th.price': { ar: 'سعرنا', en: 'Price' },
  'th.comp': { ar: 'سعر المنافس', en: 'Competitor' },
  'th.lead': { ar: 'أقصر مهلة', en: 'Shortest lead' },
  'th.supplier': { ar: 'المورد', en: 'Supplier' },
  'th.reliability': { ar: 'الموثوقية', en: 'Reliability' },
  'th.quote': { ar: 'عرض السعر', en: 'Quote' },
  'th.window': { ar: 'نافذة تفاوض', en: 'Negotiation' },
  'th.po': { ar: 'الأمر', en: 'Order' },
  'th.qty': { ar: 'الكمية', en: 'Qty' },
  'th.eta': { ar: 'الوصول', en: 'ETA' },
  'th.value': { ar: 'القيمة', en: 'Value' },
  'th.status': { ar: 'الحالة', en: 'Status' },
  'common.none': { ar: 'لا شيء', en: 'none' },
  'common.yes': { ar: 'مفتوحة', en: 'open' },
  'common.no': { ar: 'مغلقة', en: 'closed' },
  'common.live': { ar: 'مباشر', en: 'live' },
  'common.idle': { ar: 'جاهز', en: 'ready' },
  'common.running': { ar: 'قيد التشغيل', en: 'running' },
  'common.paused': { ar: 'متوقف مؤقتاً', en: 'paused' },
  'common.finished': { ar: 'منتهٍ', en: 'finished' },
  'common.bankrupt': { ar: 'إفلاس', en: 'bankrupt' },
  'common.failed': { ar: 'خطأ', en: 'failed' },
  'status.noRun': { ar: 'لا يوجد تشغيل بعد', en: 'No run yet' },
  'agents.hint': { ar: 'كل قرار يُسجَّل مع مصدره وزمنه وتكلفته', en: 'Every decision is logged with source, latency and cost' },
  'eval.hint': { ar: 'نفس المحرك ونفس البذرة لكل وضع', en: 'Same engine and seed for both modes' },
  'eval.empty': { ar: 'لا يوجد تقرير تقييم بعد. شغّل scripts/evaluate.js', en: 'No evaluation report yet. Run scripts/evaluate.js' }
};

const state = {
  lang: localStorage.getItem('arena.lang') || 'ar',
  scenarios: [],
  run: null,
  snap: null,
  fin: null,
  paused: false,
  es: null,
  evalReport: null
};

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = (key) => (DICT[key] ? DICT[key][state.lang] : key);

function money(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(state.lang === 'ar' ? 'ar-SA' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits
  }).format(n);
}
function num(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(state.lang === 'ar' ? 'ar-SA' : 'en-US', { maximumFractionDigits: digits }).format(n);
}
function pct(n) {
  return n == null ? '—' : `${num(n, 1)}%`;
}

async function api(path, opts) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch (e) {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

// ── language ───────────────────────────────────────────────────────────────

function applyLang() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === 'ar' ? 'rtl' : 'ltr';
  localStorage.setItem('arena.lang', state.lang);
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (DICT[key]) el.textContent = t(key);
  }
  $('#lang').textContent = state.lang === 'ar' ? 'EN' : 'ع';
  $('#pause').textContent = state.paused ? t('controls.resume') : t('controls.pause');
  renderAll();
}

// ── rendering ──────────────────────────────────────────────────────────────

const STATUS_CLASS = { running: 'running', ready: 'idle', finished: '', bankrupt: 'bankrupt', failed: 'failed', paused: 'paused' };

function renderStatus() {
  const chip = $('#statusChip');
  const snap = state.snap;
  if (!snap) {
    chip.className = 'chip';
    chip.textContent = t('status.noRun');
    $('#progressBar').style.width = '0%';
    $('#dayLabel').textContent = '0 / 90';
    $('#runLabel').textContent = '';
    return;
  }
  const status = state.paused ? 'paused' : snap.state.status;
  chip.className = `chip ${STATUS_CLASS[status] || ''}`;
  chip.textContent = t(`common.${status}`) || status;
  const total = snap.state.scenario.days;
  const day = snap.state.day;
  $('#progressBar').style.width = `${Math.round((day / total) * 100)}%`;
  $('#dayLabel').textContent = `${num(day)} / ${num(total)}`;
  const mode = snap.mode === 'ai' ? t('mode.ai') : t('mode.baseline');
  $('#runLabel').textContent = `${mode} · ${snap.scenario.name} · ${snap.runId}`;
}

function renderKpis() {
  const el = $('#kpis');
  const s = state.snap;
  // Same three rows as a real KPI (label, value, sub) so filling them in cannot change the height.
  const placeholder = (label) => `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">—</div><div class="sub">&nbsp;</div></div>`;
  const kpiLabels = [t('kpi.equity'), t('kpi.cash'), t('kpi.revenue'), t('kpi.margin'), t('kpi.fill'), t('kpi.inventory'), t('kpi.runway'), t('kpi.violations')];
  if (!s) {
    // Keep the strip at its final height before data arrives: a collapsing row is a layout shift.
    el.innerHTML = kpiLabels.map(placeholder).join('');
    return;
  }
  const k = s.state;
  const start = 100000;
  const delta = k.equity - start;
  const runway = state.fin && state.fin.pnl ? estimateRunway(k) : null;
  const items = [
    [t('kpi.equity'), money(k.equity), `${delta >= 0 ? '+' : ''}${money(delta)}`, delta >= 0 ? 'pos' : 'neg'],
    [t('kpi.cash'), money(k.cash), '', ''],
    [t('kpi.revenue'), money(k.totals.revenue), '', ''],
    [t('kpi.margin'), pct(s.kpis.grossMarginPct), '', ''],
    [t('kpi.fill'), pct(s.kpis.fillRate), `${num(k.totals.lostUnits)} lost`, s.kpis.fillRate > 90 ? 'pos' : s.kpis.fillRate > 70 ? '' : 'neg'],
    [t('kpi.inventory'), money(k.inventoryValue), `${num(k.inventoryUnits)} units`, ''],
    [t('kpi.runway'), runway == null ? '—' : num(runway), '', ''],
    [t('kpi.violations'), `${num(k.riskViolations.length)} / ${num(k.blockedOps.length)}`, '', '']
  ];
  el.innerHTML = items
    .map(
      ([label, value, sub, cls]) => `<div class="kpi">
        <div class="label">${esc(label)}</div>
        <div class="value ${cls}">${esc(value)}</div>
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
      </div>`
    )
    .join('');
}

function estimateRunway(k) {
  const days = k.days || [];
  const last = days.slice(-7);
  if (last.length < 2) return null;
  const burn = (last[0].cash - last[last.length - 1].cash) / Math.max(1, last.length - 1);
  if (burn <= 0) return 999;
  return Math.round(k.cash / burn);
}

function renderChart() {
  const el = $('#capitalChart');
  const s = state.snap;
  const days = s && s.state && s.state.days ? s.state.days : [];
  if (days.length < 2) {
    el.innerHTML = `<div class="empty">—</div>`;
    return;
  }
  const w = 720;
  const h = 150;
  const pad = 6;
  const values = days.map((d) => d.equity);
  const min = Math.min(...values) * 0.98;
  const max = Math.max(...values) * 1.02;
  const x = (i) => pad + (i / (days.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / Math.max(1, max - min)) * (h - pad * 2);
  const line = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.equity).toFixed(1)}`).join(' ');
  const cash = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.cash).toFixed(1)}`).join(' ');
  const area = `${line} L${x(days.length - 1).toFixed(1)},${h - pad} L${pad},${h - pad} Z`;
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f5a524" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#f5a524" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#g)"/>
    <path d="${line}" fill="none" stroke="#f5a524" stroke-width="1.8"/>
    <path d="${cash}" fill="none" stroke="#60a5fa" stroke-width="1.2" stroke-dasharray="4 3"/>
  </svg>`;
  $('#capitalHint').textContent = state.lang === 'ar' ? 'ذهبي: حقوق الملكية · أزرق: النقد' : 'gold: equity · blue: cash';
}

function renderFinancials() {
  const el = $('#financials');
  const f = state.fin;
  if (!f || !f.pnl) {
    el.innerHTML = '';
    return;
  }
  const p = f.pnl;
  const items = [
    [t('fin.revenue'), money(p.revenue)],
    [t('fin.cogs'), money(p.cogs)],
    [t('fin.gross'), `${money(p.grossProfit)} · ${pct(p.grossMarginPct)}`],
    [t('fin.opex'), money(p.opex)],
    [t('fin.net'), money(p.netProfit)],
    [t('fin.receivables'), money(f.balances.receivable)]
  ];
  el.innerHTML = items.map(([l, v]) => `<div class="fin"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div></div>`).join('');
}

function renderEvents() {
  const el = $('#events');
  const s = state.snap;
  const events = (s && s.state.activeEvents) || [];
  const fired = (s && s.state.scenario) || null;
  if (!events.length) {
    el.innerHTML = `<div class="event quiet">${esc(state.lang === 'ar' ? 'لا أحداث سوق نشطة' : 'No active market events')}</div>`;
  } else {
    el.innerHTML = events
      .map((e) => `<div class="event"><span class="tag">${esc(e.type)}</span><span>${esc(e.label)}</span><span class="muted">→ d${esc(e.endsDay)}</span></div>`)
      .join('');
  }
  if (fired) $('#capitalHint').setAttribute('data-mode', fired.id);
}

function renderPolicy() {
  const el = $('#policy');
  const s = state.snap;
  // Policy limits are configuration, not run state: show them before the first run too.
  const p = s ? s.state.policy : state.defaults && state.defaults.policy;
  if (!p) {
    el.innerHTML = '<div class="empty">—</div>';
    return;
  }
  const rows = [
    ['maxOrderValue', money(p.maxOrderValue)],
    ['maxPriceChangePct', pct(p.maxPriceChangePct * 100)],
    ['minCashBufferPct', pct(p.minCashBufferPct * 100)],
    ['maxCreditTermsDays', num(p.maxCreditTermsDays)],
    ['maxInventoryUnits', num(p.maxInventoryUnits)],
    ['cap:procure', s && s.state.caps.procure != null ? money(s.state.caps.procure) : '—'],
    ['creditTermsDays', s ? num(s.state.creditTermsDays) : '—']
  ];
  el.innerHTML = rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('');
}

const AGENT_LIST = [
  { id: 'ceo', title: 'CEO Agent', color: '#f5a524', mandate: 'Strategy, capital allocation and arbitration' },
  { id: 'procurement', title: 'Procurement Agent', color: '#22d3ee', mandate: 'Suppliers, landed cost and lead time' },
  { id: 'sales', title: 'Sales Agent', color: '#a78bfa', mandate: 'Pricing, margin and promotions' },
  { id: 'finance', title: 'Finance Agent', color: '#34d399', mandate: 'Liquidity, runway and credit terms' },
  { id: 'logistics', title: 'Logistics Agent', color: '#60a5fa', mandate: 'Stock cover, inbound ETA and expediting' },
  { id: 'auditor', title: 'Auditor Agent', color: '#f87171', mandate: 'Independent policy and integrity review' }
];

function renderAgents() {
  const el = $('#agents');
  const s = state.snap;
  // The board exists before the first decision: render the six roles, empty-handed.
  const agents = s && s.agents && s.agents.length ? s.agents : AGENT_LIST.map((a) => ({ ...a, turns: 0, lastAnalysis: '', lastSource: null, lastLatencyMs: 0 }));
  el.innerHTML = agents
    .map((a) => {
      const badge = a.lastSource ? `<span class="badge ${a.lastSource}">${esc(a.lastSource)}</span>` : '';
      const err = a.lastSource === 'fallback' ? 'fallback' : '';
      return `<div class="agent" style="--agent-color:${esc(a.color)}" data-agent="${esc(a.id)}">
        <h4><span>${esc(a.title)}</span>${badge}</h4>
        <div class="say">${esc(a.lastAnalysis || (state.lang === 'ar' ? 'لم يتخذ قراراً بعد' : 'No decision yet'))}</div>
        <div class="meta"><span>${esc(num(a.turns))} ${esc(state.lang === 'ar' ? 'جلسة' : 'turns')}</span><span>${esc(num(a.lastLatencyMs))} ms</span>${err ? `<span class="badge fallback">${esc(err)}</span>` : ''}</div>
      </div>`;
    })
    .join('');
  const u = (s && s.usage) || {};
  const llm = u.llm || {};
  const calls = llm.totals ? llm.totals.calls : llm.calls || 0;
  const cost = llm.totals ? llm.totals.costUsd : llm.spentUsd || 0;
  const failed = llm.totals ? llm.totals.failed : 0;
  $('#agentHint').textContent = calls
    ? `${num(calls)} calls · $${Number(cost).toFixed(4)} · ${num(failed)} failed`
    : t('agents.hint');
}

function renderTimeline() {
  const el = $('#timeline');
  const s = state.snap;
  if (!s || !s.lastCycle) {
    el.innerHTML = Array.from({ length: 3 })
      .map((_, i) => `<div class="tl-item placeholder"><div class="head"><span>C${i + 1}</span><span>—</span></div><div class="acts"><span class="pill">—</span></div></div>`)
      .join('');
    return;
  }
  const cycle = s.lastCycle;
  const rows = (cycle.details || [])
    .map((d) => {
      const cls = d.status === 'executed' ? 'ok' : d.status === 'refused' ? 'no' : d.status === 'vetoed' ? 'warn' : '';
      const label = `${d.action.type}${d.action.sku ? ' ' + d.action.sku : ''}${d.action.poId ? ' ' + d.action.poId : ''}`;
      return `<span class="pill ${cls}" title="${esc(d.reason || '')}">${esc(d.agent)}: ${esc(label)}</span>`;
    })
    .join('');
  el.innerHTML = `<div class="tl-item">
      <div class="head"><span>${esc(cycle.cycle)} · d${esc(cycle.day)}</span><span>${esc(money(cycle.equityBefore))} → ${esc(money(cycle.equityAfter))}</span></div>
      <div class="acts">${rows || `<span class="pill">${esc(t('common.none'))}</span>`}</div>
    </div>
    ${(s.decisions || [])
      .slice()
      .reverse()
      .filter((d) => d.role === 'ceo')
      .slice(0, 6)
      .map(
        (d) => `<div class="tl-item">
          <div class="head"><span>CEO · d${esc(d.day)}</span><span>${esc(num(Math.round((d.confidence || 0) * 100)))}%</span></div>
          <div>${esc(d.strategy || d.analysis || '')}</div>
        </div>`
      )
      .join('')}`;
}

function renderInventory() {
  const el = $('#inventory');
  const s = state.snap;
  if (!s) {
    el.innerHTML = `<table><thead><tr><th>${esc(t('th.sku'))}</th><th>${esc(t('th.onhand'))}</th><th>${esc(t('th.inbound'))}</th><th>${esc(t('th.cover'))}</th><th>${esc(t('th.price'))}</th><th>${esc(t('th.comp'))}</th></tr></thead><tbody>${Array.from({ length: 4 }).map(() => '<tr><td>—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr>').join('')}</tbody></table>`;
    return;
  }
  const inv = s.state.inventory;
  const prices = s.state.prices;
  const comp = s.state.competitorPrices;
  const cover = s.state.cover || {};
  const inbound = {};
  for (const po of s.state.purchaseOrders) if (po.status === 'in_transit') inbound[po.sku] = (inbound[po.sku] || 0) + po.qty;
  const rows = Object.keys(inv)
    .map((sku) => {
      const days = cover[sku] != null ? cover[sku] : '—';
      const under = typeof days === 'number' && days < 10;
      return `<tr>
        <td><strong>${esc(sku)}</strong></td>
        <td class="num">${esc(num(inv[sku]))}</td>
        <td class="num">${esc(num(inbound[sku] || 0))}</td>
        <td class="num ${under ? 'neg' : ''}">${esc(days)}</td>
        <td class="num">${esc(money(prices[sku], 2))}</td>
        <td class="num">${esc(money(comp[sku], 2))}</td>
      </tr>`;
    })
    .join('');
  el.innerHTML = `<table><thead><tr>
      <th>${esc(t('th.sku'))}</th><th>${esc(t('th.onhand'))}</th><th>${esc(t('th.inbound'))}</th>
      <th>${esc(t('th.cover'))}</th><th>${esc(t('th.price'))}</th><th>${esc(t('th.comp'))}</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderSuppliers() {
  const el = $('#suppliers');
  const s = state.snap;
  if (!s) {
    el.innerHTML = `<table><thead><tr><th>${esc(t('th.supplier'))}</th><th>${esc(t('th.reliability'))}</th><th>${esc(t('th.lead'))}</th><th>${esc(t('th.quote'))}</th><th>${esc(t('th.window'))}</th></tr></thead><tbody>${Array.from({ length: 4 }).map(() => '<tr><td>—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td>—</td></tr>').join('')}</tbody></table>`;
    $('#purchaseOrders').innerHTML = '';
    return;
  }
  const skus = Object.keys(s.state.prices);
  const rows = s.state.suppliers
    .map((sup) => {
      const quotes = skus.map((sku) => `${sku} ${money(sup.quotes[sku], 2)}`).join(' · ');
      return `<tr>
        <td><strong>${esc(sup.name)}</strong><div class="muted mono">${esc(sup.id)}</div></td>
        <td class="num">${esc(pct(sup.reliability * 100))}</td>
        <td class="num">${esc(num(sup.leadDays))}</td>
        <td class="num">${esc(quotes)}</td>
        <td>${sup.negotiationOpen ? `<span class="pill ok">${esc(t('common.yes'))}</span>` : `<span class="pill">${esc(t('common.no'))}</span>`}</td>
      </tr>`;
    })
    .join('');
  el.innerHTML = `<table><thead><tr>
      <th>${esc(t('th.supplier'))}</th><th>${esc(t('th.reliability'))}</th><th>${esc(t('th.lead'))}</th><th>${esc(t('th.quote'))}</th><th>${esc(t('th.window'))}</th>
    </tr></thead><tbody>${rows}</tbody></table>`;

  const pos = (s.state.purchaseOrders || []).slice(-8).reverse();
  $('#purchaseOrders').innerHTML = pos.length
    ? `<table><thead><tr><th>${esc(t('th.po'))}</th><th>${esc(t('th.sku'))}</th><th>${esc(t('th.qty'))}</th><th>${esc(t('th.eta'))}</th><th>${esc(t('th.value'))}</th><th>${esc(t('th.status'))}</th></tr></thead><tbody>${pos
        .map(
          (po) => `<tr><td class="mono">${esc(po.id)}</td><td>${esc(po.sku)}</td><td class="num">${esc(num(po.qty))}</td><td class="num">d${esc(num(po.arrivalDay))}</td><td class="num">${esc(money(po.value))}</td><td>${esc(po.status)}</td></tr>`
        )
        .join('')}</tbody></table>`
    : `<div class="empty">${esc(t('common.none'))}</div>`;
}

let auditCache = [];
async function loadAudit() {
  if (!state.snap) return;
  try {
    const res = await api(`/api/runs/${encodeURIComponent(state.snap.runId)}/audit?limit=120`);
    auditCache = res.entries || [];
    renderAudit(res.count);
  } catch (e) {
    /* run may have rolled over */
  }
}

function renderAudit(count) {
  const el = $('#audit');
  // Live runs read /audit; a saved run carries an audit tail inside its snapshot.
  const source = auditCache.length ? auditCache : (state.snap && state.snap.state && state.snap.state.auditTail) || [];
  const total = count != null ? count : source.length;
  $('#auditCount').textContent = `${num(total)} ${state.lang === 'ar' ? 'قيد' : 'entries'}`;
  const rows = source
    .slice()
    .reverse()
    .slice(0, 80)
    .map((e) => {
      const cls = e.type === 'refused' ? 'refused' : e.type === 'invariant_violation' || e.type === 'bankruptcy' ? 'refused' : '';
      return `<div class="log-row ${cls}"><span class="d">d${esc(e.day)}</span><span class="a">${esc(e.actor)}</span><span class="t">${esc(e.detail)}</span></div>`;
    })
    .join('');
  el.innerHTML =
    rows ||
    Array.from({ length: 6 })
      .map(() => '<div class="log-row"><span class="d">—</span><span class="a">—</span><span class="t">—</span></div>')
      .join('');
}

async function loadEvaluation() {
  try {
    const report = await api('/api/eval');
    state.evalReport = report && report.scenarios && report.scenarios.length ? report : null;
  } catch (e) {
    state.evalReport = null;
  }
  renderEvaluation();
}

function renderEvaluation() {
  const el = $('#evaluation');
  const r = state.evalReport;
  if (!r) {
    el.innerHTML = `<div class="empty">${esc(t('eval.empty'))}</div>`;
    return;
  }
  $('#evalHint').textContent = `${r.model} · ${r.generatedAt.slice(0, 16).replace('T', ' ')}`;
  const rows = r.scenarios
    .map(
      (s) => `<tr>
        <td>${esc(s.scenario)}</td>
        <td class="num">${esc(money(s.baseline.finalEquity))}</td>
        <td class="num">${esc(money(s.ai.finalEquity))}</td>
        <td class="num ${s.comparison.equityDiff >= 0 ? 'pos' : 'neg'}">${esc((s.comparison.equityDiff >= 0 ? '+' : '') + money(s.comparison.equityDiff))}</td>
        <td class="num">${esc(pct(s.baseline.fillRate))} → ${esc(pct(s.ai.fillRate))}</td>
      </tr>`
    )
    .join('');
  el.innerHTML = `<table><thead><tr>
      <th>${esc(state.lang === 'ar' ? 'السوق' : 'scenario')}</th>
      <th>${esc(t('mode.baseline'))}</th><th>${esc(t('mode.ai'))}</th>
      <th>${esc(state.lang === 'ar' ? 'الفرق' : 'delta')}</th>
      <th>${esc(t('kpi.fill'))}</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div class="muted" style="margin-top:8px">${esc(
      state.lang === 'ar'
        ? `تكلفة النماذج $${r.totals.aiCostUsd.toFixed(4)} عبر ${r.totals.aiCalls} نداء`
        : `model cost $${r.totals.aiCostUsd.toFixed(4)} across ${r.totals.aiCalls} calls`
    )}</div>`;
}

function renderAll() {
  renderStatus();
  renderKpis();
  renderChart();
  renderFinancials();
  renderEvents();
  renderPolicy();
  renderAgents();
  renderTimeline();
  renderInventory();
  renderSuppliers();
  renderAudit();
  renderEvaluation();
}

// ── data flow ──────────────────────────────────────────────────────────────

async function loadFinancials() {
  if (!state.snap) return;
  try {
    state.fin = await api(`/api/runs/${encodeURIComponent(state.snap.runId)}/financials`);
  } catch (e) {
    state.fin = null;
  }
}

function attachStream(runId) {
  if (state.es) state.es.close();
  state.es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
  state.es.addEventListener('state', (ev) => {
    const data = JSON.parse(ev.data);
    state.snap = data;
    state.paused = Boolean(data.paused);
    renderAll();
  });
  state.es.addEventListener('done', (ev) => {
    state.snap = JSON.parse(ev.data);
    renderAll();
    loadAudit();
    loadEvaluation();
  });
  state.es.addEventListener('control', (ev) => {
    const data = JSON.parse(ev.data);
    state.paused = Boolean(data.paused);
    applyLang();
  });
  state.es.addEventListener('error', () => {
    /* EventSource retries automatically */
  });
}

async function loadRun(runId) {
  const gen = (state.loadGen || 0) + 1;
  state.loadGen = gen;
  const snap = await api(`/api/runs/${encodeURIComponent(runId)}`);
  if (state.loadGen !== gen) return; // a newer run was selected while this request was in flight
  state.snap = snap;
  state.paused = Boolean(state.snap.paused);
  if (snap.scenario && snap.scenario.id && $('#scenario')) $('#scenario').value = snap.scenario.id;
  if (snap.mode && $('#mode')) $('#mode').value = snap.mode;
  await loadFinancials();
  if (state.loadGen !== gen) return;
  applyLang();
  if (state.snap.live) attachStream(runId);
  loadAudit();
}

async function bootstrap() {
  applyLang();
  const info = await api('/api/health');
  $('#buildInfo').textContent = `agent-arena · ${info.commit.slice(0, 8)} · ${info.model.name}${info.model.enabled ? '' : ' (no model credential — fallback policies)'}`;

  const data = await api('/api/scenarios');
  state.scenarios = data.scenarios;
  state.defaults = { policy: data.policy, economics: data.economics };
  $('#scenario').innerHTML = data.scenarios
    .map((s) => `<option value="${esc(s.id)}">${esc(state.lang === 'ar' ? s.name : s.name.replace('Scenario', 'Scenario'))}</option>`)
    .join('') + `<option value="heldout">${esc(state.lang === 'ar' ? 'سوق غير مرئي (مولّد)' : 'Evaluator held-out (generated)')}</option>`;

  const runs = await api('/api/runs');
  loadEvaluation();
  if (state.userStarted) return;
  const requested = new URLSearchParams(location.search).get('run');
  if (requested) {
    await loadRun(requested);
    return;
  }
  if (runs.active) {
    await loadRun(runs.active);
  } else if (runs.runs && runs.runs.length) {
    await loadRun(runs.runs[0].runId);
  } else {
    renderAll();
  }

  setInterval(() => {
    if (state.snap && state.snap.live) loadFinancials().then(renderFinancials);
  }, 4000);
}

// ── controls ───────────────────────────────────────────────────────────────

async function start() {
  state.userStarted = true;
  const scenarioId = $('#scenario').value;
  const mode = $('#mode').value;
  try {
    const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ scenarioId, mode, speedMs: 120 }) });
    state.paused = false;
    await loadRun(res.runId);
  } catch (e) {
    alert(e.message);
  }
}

async function control(action) {
  if (!state.snap) return;
  try {
    await api(`/api/runs/${encodeURIComponent(state.snap.runId)}/control`, {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    if (action === 'pause') state.paused = true;
    if (action === 'resume') state.paused = false;
    if (action === 'step') state.paused = true;
    if (action === 'reset') {
      const runs = await api('/api/runs');
      if (runs.active) await loadRun(runs.active);
    }
    applyLang();
  } catch (e) {
    alert(e.message);
  }
}

$('#start').addEventListener('click', start);
$('#pause').addEventListener('click', () => control(state.paused ? 'resume' : 'pause'));
$('#step').addEventListener('click', () => control('step'));
$('#reset').addEventListener('click', () => control('reset'));
$('#lang').addEventListener('click', () => {
  state.lang = state.lang === 'ar' ? 'en' : 'ar';
  applyLang();
});

bootstrap().catch((err) => {
  console.error(err);
  $('#statusChip').textContent = String(err.message);
});
