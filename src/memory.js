'use strict';
/**
 * Organisational memory.
 *
 * Shared across the six agents, bounded, persisted with the run. Retrieval is a
 * deterministic lexical score (token overlap x recency decay x importance) so a
 * replay with the same inputs retrieves the same memories — model behaviour
 * stays reproducible up to model sampling.
 */

const fs = require('node:fs');
const path = require('node:path');

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'was', 'are', 'our', 'not', 'but', 'has', 'have', 'into', 'than', 'then', 'they', 'you', 'all', 'can', 'will', 'per', 'day', 'days']);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9$%.]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 2 && !STOP.has(t));
}

class OrgMemory {
  constructor({ max = 400 } = {}) {
    this.max = max;
    this.entries = [];
    this.seq = 0;
  }

  add({ day, agent, kind, text, tags = [], importance = 0.5, refs = {} }) {
    if (!text) return null;
    const entry = {
      id: `M${++this.seq}`,
      day,
      agent,
      kind,
      text: String(text).slice(0, 600),
      tags: tags.slice(0, 8),
      importance: Math.max(0, Math.min(1, importance)),
      refs
    };
    this.entries.push(entry);
    if (this.entries.length > this.max) {
      // Drop the least valuable: low importance, then oldest.
      this.entries.sort((a, b) => b.importance - a.importance || b.day - a.day);
      this.entries = this.entries.slice(0, this.max);
    }
    return entry;
  }

  retrieve(query, k = 6, { day = 90, agent = null } = {}) {
    const q = tokenize(query);
    if (!q.length || !this.entries.length) return [];
    const qset = new Set(q);
    const scored = this.entries.map((e) => {
      const tokens = tokenize(`${e.text} ${e.tags.join(' ')} ${e.kind}`);
      let overlap = 0;
      for (const t of new Set(tokens)) if (qset.has(t)) overlap += 1;
      const lexical = overlap / Math.sqrt(Math.max(1, tokens.length));
      const recency = Math.exp(-(day - e.day) / 45);
      const agentBonus = agent && e.agent === agent ? 0.15 : 0;
      const kindBonus = e.kind === 'strategy' || e.kind === 'lesson' ? 0.15 : 0;
      return { e, score: lexical + 0.35 * recency + 0.5 * e.importance + agentBonus + kindBonus };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => ({ id: x.e.id, day: x.e.day, agent: x.e.agent, kind: x.e.kind, text: x.e.text, score: Math.round(x.score * 100) / 100 }));
  }

  byKind(kind, limit = 10) {
    return this.entries.filter((e) => e.kind === kind).slice(-limit);
  }

  toJSON() {
    return { max: this.max, seq: this.seq, entries: this.entries };
  }

  static fromJSON(obj) {
    const m = new OrgMemory({ max: obj.max || 400 });
    m.entries = obj.entries || [];
    m.seq = obj.seq || 0;
    return m;
  }

  save(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 1));
  }
}

module.exports = { OrgMemory, tokenize };
