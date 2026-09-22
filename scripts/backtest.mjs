import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatMarkdown, makeFolds, runWalkForward } from '../src/evaluation/backtest.mjs';

const DAY_MS = 86_400_000;

function parseTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw Object.assign(new Error(`unexpected argument: ${token}`), { code: 'INVALID_ARGUMENT' });
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw Object.assign(new Error(`missing value for ${token}`), { code: 'INVALID_ARGUMENT' });
    args[key] = value;
    index += 1;
  }
  return args;
}

function readJsonFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.rows)) return parsed.rows;
  if (Array.isArray(parsed?.events)) return parsed.events;
  throw Object.assign(new Error('JSON input must be an array or contain rows/events'), { code: 'INVALID_INPUT' });
}

function readNdjsonFile(file) {
  const rows = [];
  for (const [index, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { throw Object.assign(new Error(`invalid NDJSON at line ${index + 1}`), { code: 'INVALID_INPUT' }); }
  }
  return rows;
}

export function loadRows(inputPath) {
  if (!inputPath) throw Object.assign(new Error('--input is required'), { code: 'INVALID_ARGUMENT' });
  const absolute = path.resolve(inputPath);
  if (!fs.existsSync(absolute)) throw Object.assign(new Error('input does not exist'), { code: 'INVALID_INPUT' });
  if (fs.statSync(absolute).isDirectory()) {
    const files = fs.readdirSync(absolute).filter(name => name.endsWith('.ndjson')).sort();
    return files.flatMap(name => readNdjsonFile(path.join(absolute, name)));
  }
  if (absolute.endsWith('.ndjson')) return readNdjsonFile(absolute);
  return readJsonFile(absolute);
}

function executionAssumptions(args) {
  return {
    notionalUsd: parseNumber(args.notionalUsd),
    feeRate: parseNumber(args.feeRate),
    priorityUsd: parseNumber(args.priorityUsd),
    mevReserveRate: parseNumber(args.mevReserveRate)
  };
}

function defaultOutputPath() {
  return path.resolve('state', 'reports', 'backtest.json');
}

export function runBacktestCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const rows = loadRows(args.input);
  const times = rows.map(row => parseTime(row.observedAt ?? row.at)).filter(value => value !== null).sort((a, b) => a - b);
  const start = parseTime(args.start) ?? times[0] ?? null;
  const end = parseTime(args.end) ?? (times.length ? times.at(-1) + 1 : null);
  const cutoff = parseTime(args.cutoff) ?? times.at(-1) ?? null;
  const folds = start !== null && end !== null
    ? makeFolds({
      start,
      end,
      trainDays: Number(args.trainDays || 30),
      validationDays: Number(args.validationDays || 7),
      testDays: Number(args.testDays || 7)
    })
    : [];
  const report = runWalkForward(rows, {
    folds,
    cutoff,
    ruleVersion: args.ruleVersion || 'radar-v3',
    threshold: parseNumber(args.threshold) ?? .5,
    executionAssumptions: executionAssumptions(args)
  });
  const output = path.resolve(args.output || defaultOutputPath());
  const markdown = path.resolve(args.markdown || output.replace(/\.json$/i, '.md'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.dirname(markdown), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(markdown, formatMarkdown(report), { mode: 0o600 });
  return { output, markdown, report };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    runBacktestCli();
  } catch (error) {
    console.error(error?.message || 'backtest failed');
    process.exitCode = 1;
  }
}
