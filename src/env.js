// Minimal .env loader (no dependencies). Existing process.env values win.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const file = join(ROOT, '.env');
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (value !== '' && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export const env = (key, fallback = '') => process.env[key] ?? fallback;
