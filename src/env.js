'use strict';
/**
 * Minimal .env loader.
 *
 * The app reads a credential but never writes one. Search order, first wins,
 * and anything already present in the real environment is never overridden:
 *   1. process.env (explicit environment / Render dashboard)
 *   2. <repo>/.env            (local development, git-ignored)
 *   3. <home>/.env
 *   4. $HERMES_HOME/.env or %LOCALAPPDATA%/hermes/.env (where Hermes keeps keys)
 *
 * Values are parsed conservatively: only KEY=VALUE lines, optional quotes.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function candidates() {
  const list = [];
  list.push(path.join(process.cwd(), '.env'));
  list.push(path.join(os.homedir(), '.env'));
  const hermesHome = process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes');
  list.push(path.join(hermesHome, '.env'));
  return list;
}

let loaded = false;

function loadEnv() {
  if (loaded) return { loaded: true, files: [] };
  loaded = true;
  const used = [];
  for (const file of candidates()) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    used.push(file);
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] !== undefined) continue;
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
  return { loaded: true, files: used };
}

module.exports = { loadEnv };
