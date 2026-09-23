import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, readJsonWithBackup } from './local-store.mjs';
import { RiskMemory } from './analytics/risk-memory.mjs';

function cleanCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const { rawDiscovery: _rawDiscovery, ...clean } = candidate;
  return clean;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function objectRows(value) {
  return Array.isArray(value)
    ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row))
    : [];
}

function cleanCandidates(value) {
  return objectRows(value).map(cleanCandidate).filter(Boolean);
}

function normalizeScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    ...value,
    candidates: cleanCandidates(value.candidates),
    rejected: objectRows(value.rejected),
    auditQueue: objectRows(value.auditQueue),
    outcomes: objectRows(value.outcomes),
    events: objectRows(value.events),
    lifecycle: objectRows(value.lifecycle),
    auditQueueStats: objectValue(value.auditQueueStats),
    sourceHealth: objectValue(value.sourceHealth),
    outcomeSummary: objectValue(value.outcomeSummary)
  };
}

function normalizeChainStates(value) {
  return Object.fromEntries(Object.entries(objectValue(value)).map(([chain, scope]) => [chain, normalizeScope(scope)]).filter(([, scope]) => scope));
}

function defaultState() {
  return {
    version: 4,
    status: 'STARTING',
    generatedAt: 0,
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    nextCycleAt: 0,
    cycleStartedAt: 0,
    scanInProgress: false,
    activeChain: 'robinhood',
    pendingChain: '',
    supportedChains: ['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable'],
    chainStates: {},
    riskExclusions: {},
    riskMemory: [],
    scanCount: 0,
    discoveredCount: 0,
    prequalifiedCount: 0,
    candidates: [],
    rejected: [],
    auditQueue: [],
    auditQueueStats: { total: 0, due: 0, neverAudited: 0, waitingRecheck: 0 },
    outcomes: [],
    outcomeSummary: {
      minimumSample: 50, calibrationReady: false, canStartObservation: false,
      calibrationMinimumSample: 500, calibrationStatus: 'INSUFFICIENT', calibrationSampleCount: 0,
      tracked: 0, completed5m: 0, completed15m: 0, completed30m: 0,
      completed1h: 0, completed2h: 0, completed6h: 0, completed24h: 0
    },
    sourceHealth: {},
    lifecycle: [],
    creatorHistory: [],
    events: []
  };
}

function migrateState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  let memory = new RiskMemory(raw.riskMemory || []);
  if (!memory.rows.length) memory = new RiskMemory(raw.riskExclusions || {});
  const normalized = normalizeScope(raw) || {};
  return {
    ...base,
    ...raw,
    ...normalized,
    version: 4,
    riskMemory: memory.serialize(),
    riskExclusions: memory.toObject(Date.now()),
    scanInProgress: false,
    chainStates: normalizeChainStates(raw.chainStates),
    creatorHistory: objectRows(raw.creatorHistory)
  };
}

export class RadarState {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'radar.json');
    this.value = this.load();
  }

  load() {
    const loaded = readJsonWithBackup(this.file, defaultState());
    const value = migrateState(loaded.value);
    if (loaded.recovered) value.events.unshift({ at: Date.now(), type: 'STATE_RECOVERED', message: '主状态文件异常，已从本机备份恢复' });
    return value;
  }

  save(next = this.value) {
    this.value = next;
    atomicJson(this.file, next);
  }

  event(type, message, data = {}) {
    const events = this.value.events || [];
    events.unshift({ at: Date.now(), type, message, ...data });
    this.value.events = events.slice(0, 500);
  }
}
