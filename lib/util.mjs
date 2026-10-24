import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-][\w.-]{0,180}$/.test(value) && value !== '..';

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export const short = (text, n = 60) => { const v = String(text ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n)}…` : v; };
