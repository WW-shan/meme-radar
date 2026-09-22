export const LIFECYCLE_ORDER = Object.freeze({ new_creation: 0, near_completion: 1, completed: 2, migrated: 3 });

function key(chain, address) {
  return `${chain}:${String(address || '').trim()}`;
}

export class LifecycleTracker {
  constructor(snapshot = []) {
    this.rows = new Map();
    for (const row of Array.isArray(snapshot) ? snapshot : []) {
      if (row?.chain && row?.address) this.rows.set(key(row.chain, row.address), structuredClone(row));
    }
  }

  observe(event = {}) {
    if (event.stage === 'signal') {
      throw Object.assign(new Error('signal is not a lifecycle stage'), { code: 'SIGNAL_NOT_LIFECYCLE' });
    }
    if (!Object.hasOwn(LIFECYCLE_ORDER, event.stage) || !event.chain || !event.address) {
      throw Object.assign(new Error('invalid lifecycle observation'), { code: 'INVALID_LIFECYCLE' });
    }
    const observedAt = Number(event.observedAt);
    if (!Number.isFinite(observedAt) || observedAt < 0) {
      throw Object.assign(new Error('invalid lifecycle time'), { code: 'INVALID_LIFECYCLE' });
    }
    const rowKey = key(event.chain, event.address);
    const current = this.rows.get(rowKey) || {
      chain: event.chain, address: event.address, history: [], conflicts: []
    };
    const previous = current.history.at(-1);
    if (!previous) {
      current.history.push({ stage: event.stage, observedAt, lastObservedAt: observedAt });
    } else if (LIFECYCLE_ORDER[event.stage] < LIFECYCLE_ORDER[previous.stage] || observedAt < previous.lastObservedAt) {
      current.conflicts.push({ ...event, previousStage: previous.stage, previousObservedAt: previous.lastObservedAt });
    } else if (event.stage === previous.stage) {
      previous.lastObservedAt = Math.max(previous.lastObservedAt, observedAt);
    } else {
      current.history.push({ stage: event.stage, observedAt, lastObservedAt: observedAt });
    }
    this.rows.set(rowKey, current);
    return structuredClone(current);
  }

  get(chain, address) {
    const row = this.rows.get(key(chain, address));
    return row ? structuredClone(row) : null;
  }

  stageFor(chain, address) {
    return this.get(chain, address)?.history.at(-1)?.stage || '';
  }

  snapshot() {
    return [...this.rows.values()].map(row => structuredClone(row));
  }
}
