import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calibrationReport } from '../src/evaluation/calibration.mjs';
import { loadRows } from './backtest.mjs';

function parseArgs(argv = []) {
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

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatMarkdown(report) {
  return [
    '# Probability Calibration Audit',
    '',
    `- Model version: ${report.modelVersion}`,
    `- Status: ${report.status}`,
    `- Ready: ${report.ready ? 'true' : 'false'}`,
    `- Samples: ${report.sampleCount}`,
    `- Expected calibration error: ${report.expectedCalibrationError ?? 'N/A'}`,
    `- Brier score: ${report.brierScore ?? 'N/A'}`,
    `- Data cutoff: ${report.dataCutoff ?? 'N/A'}`,
    `- Last calibrated at: ${report.lastCalibratedAt ?? 'N/A'}`,
    ''
  ].join('\n');
}

export function runModelAuditCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const rows = loadRows(args.input);
  const report = calibrationReport(rows, {
    bins: numberOrNull(args.bins) ?? 10,
    modelVersion: args.modelVersion || 'radar-v3',
    dataCutoff: numberOrNull(args.dataCutoff),
    lastCalibratedAt: numberOrNull(args.lastCalibratedAt)
  });
  const output = path.resolve(args.output || path.join('state', 'reports', 'model-audit.json'));
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
    runModelAuditCli();
  } catch (error) {
    console.error(error?.message || 'model audit failed');
    process.exitCode = 1;
  }
}
