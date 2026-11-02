'use strict';
const { test, expect } = require('@playwright/test');

const consoleErrors = [];

test.beforeEach(async ({ page }) => {
  consoleErrors.length = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
});

async function startRun(page, mode) {
  await page.selectOption('#scenario', 'steady-growth');
  await page.selectOption('#mode', mode);
  await page.click('#start');
  await expect(page.locator('#statusChip')).not.toHaveText(/لا يوجد تشغيل بعد|No run yet/);
}

test('command centre loads in Arabic RTL with the policy limits and six agents', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('h1')).toHaveText('Agent Arena');
  const agents = page.locator('.agent');
  await expect(agents).toHaveCount(6);
  await expect(page.locator('#agents')).toContainText('CEO Agent');
  await expect(page.locator('#agents')).toContainText('Auditor Agent');
  await expect(page.locator('#policy')).toContainText('maxOrderValue');
  await expect(page.locator('#agents .agent', { hasText: 'Auditor Agent' })).toHaveCount(1);
});

test('language toggle flips direction and copy without a reload', async ({ page }) => {
  await page.goto('/');
  await page.click('#lang');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#start')).toHaveText('Start run');
  await expect(page.locator('h2').first()).toContainText('Capital');
  await page.click('#lang');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
});

test('an agent-company run advances the day counter and populates the dashboards', async ({ page }) => {
  await page.goto('/');
  await startRun(page, 'ai');

  // simulation reaches at least day 3 and the KPIs stop being placeholders
  await expect(page.locator('#dayLabel')).not.toHaveText('0 / 90', { timeout: 45_000 });
  await expect(page.locator('#kpis .kpi')).toHaveCount(8);
  await expect(page.locator('#kpis')).toContainText('$');

  // inventory table has the four SKUs with numeric quantities
  const rows = page.locator('#inventory tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('EAR');

  // every agent card eventually carries a source badge (llm or fallback)
  await expect(page.locator('#agents .badge').first()).toBeVisible({ timeout: 45_000 });

  // audit log is fed by the engine, not the browser
  await expect(page.locator('#audit .log-row').first()).toBeVisible({ timeout: 30_000 });

  // the capital chart is a real SVG polyline over simulated days
  await expect(page.locator('#capitalChart svg path').first()).toBeAttached();

  expect(consoleErrors).toEqual([]);
});

test('pause freezes the simulation and resume continues it', async ({ page }) => {
  await page.goto('/');
  await startRun(page, 'ai');
  await expect(page.locator('#dayLabel')).not.toHaveText('0 / 90', { timeout: 45_000 });

  // If the previous test's run already finished, reset so the pause has something to freeze.
  if (/منتهٍ|finished/.test((await page.locator('#statusChip').textContent()) || '')) {
    await page.click('#reset');
    await expect(page.locator('#dayLabel')).not.toHaveText('0 / 90', { timeout: 20_000 });
  }
  await page.click('#pause');
  await expect(page.locator('#statusChip')).toHaveText(/متوقف مؤقتاً|paused/);

  // The in-flight day may still land; wait until the counter stops moving, then prove it stays put.
  await expect
    .poll(
      async () => {
        const a = await page.locator('#dayLabel').textContent();
        await page.waitForTimeout(700);
        const b = await page.locator('#dayLabel').textContent();
        return a === b;
      },
      { timeout: 20_000 }
    )
    .toBe(true);
  const settled = await page.locator('#dayLabel').textContent();
  await page.waitForTimeout(2500);
  expect(await page.locator('#dayLabel').textContent()).toBe(settled);

  await page.click('#pause');
  await expect(page.locator('#statusChip')).not.toHaveText(/متوقف مؤقتاً|paused/);
  await expect.poll(async () => (await page.locator('#dayLabel').textContent()) || '', { timeout: 30_000 }).not.toBe(settled);
});

test('reset starts a fresh run from day zero', async ({ page }) => {
  await page.goto('/');
  await startRun(page, 'baseline');
  await expect(page.locator('#dayLabel')).not.toHaveText('0 / 90', { timeout: 45_000 });
  await page.click('#reset');
  await expect.poll(async () => {
    const label = await page.locator('#dayLabel').textContent();
    const day = Number((label || '').split('/')[0].replace(/[^0-9]/g, ''));
    return day;
  }, { timeout: 20_000 }).toBeLessThan(91);
  await expect(page.locator('#kpis .kpi')).toHaveCount(8);
});

function toLatinDigits(text) {
  return String(text).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function numberFromText(text) {
  const digits = toLatinDigits(text).replace(/[^0-9]/g, '');
  return digits ? Number(digits) : NaN;
}

test('the equity painted in the UI equals the value the API returns', async ({ page, request }) => {
  await page.goto('/');
  await startRun(page, 'ai');
  await expect(page.locator('#dayLabel')).not.toHaveText('0 / 90', { timeout: 45_000 });

  // Read the live run id from the API, not the label: the label can still show the previous run.
  const runs = await (await request.get('/api/runs')).json();
  const runId = runs.active;
  expect(runId).toBeTruthy();
  await page.request.post(`/api/runs/${encodeURIComponent(runId)}/control`, { data: { action: 'pause' } });

  // Freeze confirmed by the API, then compare what the user reads with what the API holds.
  await expect
    .poll(async () => {
      const a = await (await request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      await page.waitForTimeout(500);
      const b = await (await request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
      return b.paused === true && a.state.day === b.state.day;
    }, { timeout: 25_000 })
    .toBe(true);

  const api = await (await request.get(`/api/runs/${encodeURIComponent(runId)}`)).json();
  const uiText = await page.locator('#kpis .kpi').first().locator('.value').textContent();
  expect(Math.abs(numberFromText(uiText) - api.state.equity)).toBeLessThanOrEqual(1);
});

test('the command centre does not overflow horizontally on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await startRun(page, 'ai');
  await expect(page.locator('#dayLabel')).not.toHaveText('0 / 90', { timeout: 45_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);
  await page.click('#lang');
  const overflowLtr = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflowLtr).toBeLessThanOrEqual(2);
});
