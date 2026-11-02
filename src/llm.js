'use strict';
/**
 * LLM transport for the agent company.
 *
 * Responsibilities kept deliberately narrow: send a prompt, bound the wait,
 * retry transient failures, account for tokens and money, and never leak the
 * credential. It knows nothing about the business — if a call fails it returns
 * {ok:false} and the caller decides how to degrade.
 *
 * Failure modes handled explicitly: HTTP 429 / 5xx, network errors, timeouts,
 * malformed JSON, empty choices, and budget exhaustion.
 */

const PRICE_TABLE = {
  // USD per 1M tokens, DeepSeek published rates (peak). Off-peak is half.
  // Source: https://api-docs.deepseek.com/quick_start/pricing (read 2026-11-02)
  'deepseek-flash': { inputMiss: 0.30, inputHit: 0.006, output: 1.20, offPeakFactor: 0.5 },
  'deepseek-v4-pro': { inputMiss: 1.32, inputHit: 0.044, output: 3.96, offPeakFactor: 0.5 },
  default: { inputMiss: 0.30, inputHit: 0.006, output: 1.20, offPeakFactor: 0.5 }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LlmClient {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || process.env.DEEPSEEK_API_KEY || '';
    this.baseUrl = (opts.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
    this.model = opts.model || process.env.AGENT_MODEL || 'deepseek-flash';
    this.timeoutMs = Number(opts.timeoutMs || process.env.AGENT_TIMEOUT_MS || 45000);
    this.maxRetries = Number(opts.maxRetries ?? 2);
    this.budgetUsd = Number(opts.budgetUsd ?? 2.0);
    this.offPeak = Boolean(opts.offPeak);
    // 'off' = non-thinking (fast, cheap), 'on' = reasoning tokens
    this.thinking = opts.thinking || process.env.AGENT_THINKING || 'off';
    // Reasoning tokens are billed inside max_tokens, so a thinking run needs headroom or the
    // JSON answer is truncated mid-object (see llm-integration-guardrails).
    this.maxTokens = Number(opts.maxTokens || process.env.AGENT_MAX_TOKENS || (this.thinking === 'on' ? 3000 : 1200));
    this.maxConcurrent = Number(opts.maxConcurrent || process.env.AGENT_MAX_CONCURRENT || 4);
    this._active = 0;
    this._queue = [];
    this.calls = [];
    this.spentUsd = 0;
    this.enabled = Boolean(this.apiKey) && opts.enabled !== false && process.env.DISABLE_LLM !== '1';
    this.failurePlan = opts.failurePlan || null; // {kind:'timeout'|'429'|'500'|'malformed', count}
    this.failuresInjected = 0;
  }

  priceFor(model) {
    return PRICE_TABLE[model] || PRICE_TABLE.default;
  }

  estimateCost({ promptTokens = 0, cachedTokens = 0, completionTokens = 0, model = this.model }) {
    const p = this.priceFor(model);
    const factor = this.offPeak ? p.offPeakFactor : 1;
    const miss = Math.max(0, promptTokens - cachedTokens);
    return (miss * p.inputMiss + cachedTokens * p.inputHit + completionTokens * p.output) * 1e-6 * factor;
  }

  redact(text) {
    let out = String(text == null ? '' : text);
    if (this.apiKey && this.apiKey.length > 6) out = out.split(this.apiKey).join('[REDACTED]');
    out = out.replace(/sk-[A-Za-z0-9_-]{6,}/g, '[REDACTED]');
    out = out.replace(/Bearer\s+[A-Za-z0-9._-]{6,}/g, 'Bearer [REDACTED]');
    return out.slice(0, 800);
  }

  _injectFailure() {
    if (!this.failurePlan || this.failuresInjected >= this.failurePlan.count) return null;
    this.failuresInjected += 1;
    return this.failurePlan.kind;
  }

  /** Bounded concurrency: never let a board meeting open more than N provider sockets. */
  async _acquire() {
    if (this._active < this.maxConcurrent) {
      this._active += 1;
      return;
    }
    await new Promise((resolve) => this._queue.push(resolve));
    this._active += 1;
  }

  _release() {
    this._active = Math.max(0, this._active - 1);
    const next = this._queue.shift();
    if (next) next();
  }

  /**
   * @returns {{ok:boolean, content?:string, json?:object, usage:object, costUsd:number,
   *            latencyMs:number, attempts:number, error?:string, agent:string, model:string}}
   */
  async decide({ agent, system, user, maxTokens = this.maxTokens, temperature = 0.3 }) {
    const started = Date.now();
    const record = {
      agent,
      model: this.model,
      ok: false,
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      attempts: 0,
      error: null,
      at: new Date().toISOString()
    };

    if (!this.enabled) {
      record.error = 'llm_disabled_no_credential';
      record.latencyMs = Date.now() - started;
      this.calls.push(record);
      return record;
    }
    if (this.spentUsd >= this.budgetUsd) {
      record.error = 'budget_exhausted';
      record.latencyMs = Date.now() - started;
      this.calls.push(record);
      return record;
    }

    let attempt = 0;
    while (attempt <= this.maxRetries) {
      attempt += 1;
      record.attempts = attempt;
      const injected = this._injectFailure();
      try {
        if (injected === 'timeout') throw Object.assign(new Error('injected timeout'), { code: 'TIMEOUT' });
        if (injected === '429') throw Object.assign(new Error('injected rate limit'), { code: 'http_429' });
        if (injected === '500') throw Object.assign(new Error('injected upstream failure'), { code: 'http_500' });

        await this._acquire();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let res;
        const body = {
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          response_format: { type: 'json_object' },
          max_tokens: maxTokens,
          temperature,
          stream: false
        };
        if (this.thinking === 'off') body.thinking = { type: 'disabled' };
        try {
          res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
          this._release();
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`http_${res.status}: ${this.redact(body)}`);
          err.code = `http_${res.status}`;
          err.retryable = res.status === 429 || res.status >= 500;
          throw err;
        }

        const data = await res.json();
        const choice = data.choices && data.choices[0];
        if (!choice || !choice.message || typeof choice.message.content !== 'string') {
          throw Object.assign(new Error('empty completion'), { code: 'bad_response', retryable: true });
        }
        const usage = data.usage || {};
        const cached = usage.prompt_cache_hit_tokens || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
        record.usage = {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          cachedTokens: cached,
          reasoningTokens: (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0
        };
        record.content = choice.message.content;
        record.costUsd = this.estimateCost({ ...record.usage, model: data.model || this.model });
        this.spentUsd += record.costUsd;
        // The budget guard is checked before the call; a single call can still cross it,
        // so stop the run from making any further calls once it has.
        record.overBudget = this.spentUsd >= this.budgetUsd;
        record.ok = true;
        record.error = null;
        record.latencyMs = Date.now() - started;
        try {
          record.json = JSON.parse(record.content);
        } catch (e) {
          // Model returned prose around the JSON: take the outermost object.
          const start = record.content.indexOf('{');
          const end = record.content.lastIndexOf('}');
          if (start >= 0 && end > start) {
            try {
              record.json = JSON.parse(record.content.slice(start, end + 1));
            } catch (e2) {
              record.ok = false;
              record.error = `unparseable_json: ${this.redact(e2.message)}`;
            }
          } else {
            record.ok = false;
            record.error = 'unparseable_json: no object found';
          }
        }
        if (!record.ok) throw Object.assign(new Error(record.error), { code: 'bad_json', retryable: true });
        this.calls.push(record);
        return record;
      } catch (err) {
        const retryable = err.retryable !== false;
        record.error = this.redact(`${err.code || err.name}: ${err.message}`);
        record.latencyMs = Date.now() - started;
        const last = attempt > this.maxRetries;
        if (!retryable || last) {
          this.calls.push(record);
          return record;
        }
        const backoff = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        await sleep(backoff);
      }
    }
    this.calls.push(record);
    return record;
  }

  summary() {
    const byAgent = {};
    for (const c of this.calls) {
      const a = (byAgent[c.agent] = byAgent[c.agent] || { calls: 0, ok: 0, failed: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0 });
      a.calls += 1;
      if (c.ok) a.ok += 1;
      else a.failed += 1;
      a.promptTokens += c.usage.promptTokens;
      a.completionTokens += c.usage.completionTokens;
      a.costUsd += c.costUsd;
      a.latencyMs += c.latencyMs;
    }
    const totals = Object.values(byAgent).reduce(
      (s, a) => ({
        calls: s.calls + a.calls,
        ok: s.ok + a.ok,
        failed: s.failed + a.failed,
        promptTokens: s.promptTokens + a.promptTokens,
        completionTokens: s.completionTokens + a.completionTokens,
        costUsd: s.costUsd + a.costUsd
      }),
      { calls: 0, ok: 0, failed: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }
    );
    return {
      model: this.model,
      enabled: this.enabled,
      budgetUsd: this.budgetUsd,
      spentUsd: Math.round(this.spentUsd * 1e6) / 1e6,
      totals: { ...totals, costUsd: Math.round(totals.costUsd * 1e6) / 1e6 },
      byAgent
    };
  }
}

module.exports = { LlmClient, PRICE_TABLE };
