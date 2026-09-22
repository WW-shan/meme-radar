import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, readJsonWithBackup } from '../local-store.mjs';

function validCursor(value) {
  if (Number.isSafeInteger(value) && value >= 0) return true;
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
}

function corrupt() {
  return Object.assign(new Error('chain cursor store is corrupt'), { code: 'CHAIN_CURSOR_CORRUPT' });
}

// A corrupt cursor file must never take the whole radar down: chain events are
// an optional early signal, and the cursor only records how far the scanner
// already walked. Quarantine the unreadable file so it can be inspected, then
// restart from a clean cursor instead of scanning from an unknown position.
export function openChainCursorStore(directory, { onCorrupt = () => {} } = {}) {
  try {
    return new ChainCursorStore(directory);
  } catch (error) {
    if (error?.code !== 'CHAIN_CURSOR_CORRUPT' && error?.code !== 'STATE_CORRUPT') throw error;
    const base = path.resolve(directory);
    const quarantined = [];
    for (const name of ['chain-cursors.json', 'chain-cursors.json.bak']) {
      const source = path.join(base, name);
      if (!fs.existsSync(source)) continue;
      const target = `${source}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(source, target);
        quarantined.push(target);
      } catch {}
    }
    onCorrupt({ code: error.code, file: path.join(base, 'chain-cursors.json'), quarantined });
    return new ChainCursorStore(directory);
  }
}

export class ChainCursorStore {
  constructor(directory) {
    this.file = path.join(path.resolve(directory), 'chain-cursors.json');
    const fallback = { version: 1, cursors: {} };
    const loaded = readJsonWithBackup(this.file, fallback).value;
    if (loaded?.version !== 1 || !loaded.cursors || typeof loaded.cursors !== 'object' || Array.isArray(loaded.cursors)) {
      throw corrupt();
    }
    for (const value of Object.values(loaded.cursors)) if (!validCursor(value)) throw corrupt();
    this.value = { version: 1, cursors: { ...loaded.cursors } };
  }

  get(name) {
    return this.value.cursors[String(name)] ?? null;
  }

  set(name, cursor) {
    const key = String(name || '').trim();
    if (!key || !validCursor(cursor)) throw new TypeError('invalid chain cursor');
    this.value = {
      version: 1,
      cursors: { ...this.value.cursors, [key]: cursor }
    };
    atomicJson(this.file, this.value);
    return this;
  }
}
