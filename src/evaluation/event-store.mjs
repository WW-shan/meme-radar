import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STAGES = new Set(['new_creation', 'near_completion', 'completed', 'migrated', 'signal']);

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
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
  }

  file(at = this.now()) {
    return path.join(this.directory, `${new Date(at).toISOString().slice(0, 10)}.ndjson`);
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
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').split('\n');
      for (const line of existing) {
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch {
          throw Object.assign(new Error('event store contains a corrupt line'), { code: 'EVENT_STORE_CORRUPT' });
        }
        if (parsed.eventId === eventId) return row;
      }
    }
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return row;
  }

  async read({ chain = '', stage = '' } = {}) {
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
        rows.push(row);
      }
    }
    return rows.sort((a, b) => a.observedAt - b.observedAt || String(a.eventId).localeCompare(String(b.eventId)));
  }
}
