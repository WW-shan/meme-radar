import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STAGES = new Set(['new_creation', 'near_completion', 'completed', 'migrated', 'signal', 'outcome']);

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function invalidEvent() {
  return Object.assign(new Error('invalid event'), { code: 'INVALID_EVENT' });
}

export class EventStore {
  constructor(directory, { now = Date.now } = {}) {
    this.directory = path.resolve(directory, 'events');
    this.now = now;
    this.index = new Map();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
  }

  file(at = this.now()) {
    return path.join(this.directory, `${new Date(at).toISOString().slice(0, 10)}.ndjson`);
  }

  idsFor(file) {
    const entry = this.loadIds(file);
    // Only the file being appended to needs an index. Keeping an entry per day
    // would grow without bound in a long-running process, and re-reading an
    // older file on demand is still correct.
    if (this.index.size > 1) {
      this.index.clear();
      this.index.set(file, entry);
    }
    return entry;
  }

  loadIds(file) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    const cached = this.index.get(file);
    if (!stat) {
      if (cached && cached.size === 0 && cached.mtimeMs === 0) return cached;
      const empty = { ids: new Set(), size: 0, mtimeMs: 0 };
      this.index.set(file, empty);
      return empty;
    }
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    const ids = new Set();
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let parsed;
      try { parsed = JSON.parse(lines[index]); }
      catch {
        throw Object.assign(new Error(`event store corrupt at ${path.basename(file)}:${index + 1}`), { code: 'EVENT_STORE_CORRUPT' });
      }
      if (parsed?.eventId) ids.add(String(parsed.eventId));
    }
    const entry = { ids, size: stat.size, mtimeMs: stat.mtimeMs };
    this.index.set(file, entry);
    return entry;
  }

  async append(input) {
    const { eventId: _ignored, ...event } = input && typeof input === 'object' ? input : {};
    const observedAt = Number(event.observedAt ?? this.now());
    if (!event.source || typeof event.source !== 'string'
      || !event.chain || typeof event.chain !== 'string'
      || !STAGES.has(event.stage)
      || !Number.isFinite(observedAt) || observedAt < 0
      || !event.token || typeof event.token.address !== 'string' || !event.token.address.trim()
      || !event.raw || typeof event.raw !== 'object' || Array.isArray(event.raw)
      || !event.normalized || typeof event.normalized !== 'object' || Array.isArray(event.normalized)) {
      throw invalidEvent();
    }

    const normalized = { ...event, observedAt };
    const eventId = crypto.createHash('sha256').update(stable(normalized)).digest('hex');
    const row = { ...normalized, eventId };
    const file = this.file(observedAt);
    const index = this.idsFor(file);
    if (index.ids.has(eventId)) return row;
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const stat = fs.statSync(file);
    index.ids.add(eventId);
    index.size = stat.size;
    index.mtimeMs = stat.mtimeMs;
    return row;
  }

  async read({ chain = '', stage = '', from = null, to = null } = {}) {
    const hasFrom = from !== null && from !== undefined;
    const hasTo = to !== null && to !== undefined;
    const fromAt = hasFrom ? Number(from) : -Infinity;
    const toAt = hasTo ? Number(to) : Infinity;
    if (hasFrom && !Number.isFinite(fromAt) || hasTo && !Number.isFinite(toAt) || toAt < fromAt) {
      throw Object.assign(new Error('invalid event query range'), { code: 'INVALID_EVENT_QUERY' });
    }
    const rows = [];
    for (const name of fs.readdirSync(this.directory).filter(name => name.endsWith('.ndjson')).sort()) {
      const file = path.join(this.directory, name);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch {
          throw Object.assign(new Error(`event store corrupt at ${name}:${index + 1}`), { code: 'EVENT_STORE_CORRUPT' });
        }
        if (chain && row.chain !== chain) continue;
        if (stage && row.stage !== stage) continue;
        if (row.observedAt < fromAt || row.observedAt > toAt) continue;
        rows.push(row);
      }
    }
    return rows.sort((a, b) => a.observedAt - b.observedAt || String(a.eventId).localeCompare(String(b.eventId)));
  }
}
