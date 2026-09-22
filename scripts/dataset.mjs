#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPointInTimeDataset, DEFAULT_FEATURE_KEYS, DATASET_VERSION } from '../src/evaluation/dataset.mjs';
import { atomicJson } from '../src/local-store.mjs';
import { loadRows, parseArgs } from './backtest.mjs';

function parseTime(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFeatures(value) {
  if (value === undefined || value === null || value === '') return [...DEFAULT_FEATURE_KEYS];
  return [...new Set(String(value).split(',').map(item => item.trim()).filter(Boolean))];
}

export function runDatasetCli(argv = process.argv.slice(2), { now = Date.now } = {}) {
  const args = parseArgs(argv);
  const rows = loadRows(args.input || path.resolve('state', 'events'));
  const cutoff = parseTime(args.cutoff, now());
  if (!Number.isFinite(cutoff)) throw Object.assign(new Error('--cutoff is invalid'), { code: 'INVALID_ARGUMENT' });
  const featureKeys = parseFeatures(args.features);
  const data = buildPointInTimeDataset(rows, {
    cutoff,
    featureKeys,
    labelOptions: {
      successThreshold: args.successThreshold === undefined ? undefined : Number(args.successThreshold),
      rugThreshold: args.rugThreshold === undefined ? undefined : Number(args.rugThreshold)
    }
  });
  const output = path.resolve(args.output || path.join('state', 'reports', 'dataset.json'));
  atomicJson(output, {
    version: 'dataset-cli-v1',
    datasetVersion: DATASET_VERSION,
    cutoff,
    featureKeys,
    sampleCount: data.length,
    rows: data
  });
  return { output, rows: data, cutoff, featureKeys };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const result = runDatasetCli();
    console.log(`数据集已写入：${result.output}（${result.rows.length}条，cutoff=${result.cutoff}）`);
  } catch (error) {
    console.error(error?.message || 'dataset build failed');
    process.exitCode = 1;
  }
}
