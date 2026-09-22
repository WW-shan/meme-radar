import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { auditRelease, scanSensitiveArtifacts } from '../scripts/release-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('community distribution has platform launchers and excludes private runtime data', () => {
  for (const file of ['安装并启动.command', '安装并启动.bat', 'START-HERE-WINDOWS.bat', 'START-WINDOWS.bat', 'TEST-WINDOWS.bat', 'README-WINDOWS.txt', 'README.md', 'SECURITY.md',
    'THIRD_PARTY_NOTICES.md', 'docs/EDITION-BOUNDARY.md', 'docs/RELEASE-CHECKLIST.md']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should exist`);
  }
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const rule of ['state/**', 'logs/**', '.env', '.npmrc']) assert.match(ignore, new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('Windows test launcher runs in foreground so it can be stopped cleanly', () => {
  const launcher = fs.readFileSync(path.join(root, 'TEST-WINDOWS.bat'), 'utf8');
  assert.match(launcher, /node --use-env-proxy src\\main\.mjs/);
  assert.match(launcher, /start "" \/B node scripts\\wait-and-open\.mjs/i);
  assert.doesNotMatch(launcher, /scripts\\open\.mjs|start[^\r\n]*src\\main\.mjs/i);
});

test('portable Windows launcher uses only its bundled runtime', () => {
  const launcher = fs.readFileSync(path.join(root, 'packaging/windows-portable/OPEN-MEME-RADAR.bat'), 'utf8');
  assert.match(launcher, /"runtime\\node\.exe" --use-env-proxy src\\main\.mjs/);
  assert.doesNotMatch(launcher, /where node|npm|powershell/i);
});

test('portable EXE bootstrap only starts the bundled read-only application', () => {
  const launcher = fs.readFileSync(path.join(root, 'packaging/windows-portable/launcher.cjs'), 'utf8');
  assert.match(launcher, /runtime', 'node\.exe/);
  assert.match(launcher, /src', 'main\.mjs/);
  assert.doesNotMatch(launcher, /https?:|powershell|cmd\.exe|private.?key|swap/i);
});

test('Windows launcher stays local and does not require administrator privileges', () => {
  const launcher = fs.readFileSync(path.join(root, 'START-WINDOWS.bat'), 'utf8');
  assert.match(launcher, /node scripts\\open\.mjs/);
  assert.match(launcher, /cd \/d "%~dp0"/);
  assert.doesNotMatch(launcher, /powershell|runas|netsh|reg(?:\.exe)?\s+add/i);
});

test('open-source release metadata uses AGPL and remains blocked from accidental npm publishing', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'AGPL-3.0-only');
  assert.equal(fs.existsSync(path.join(root, 'LICENSE')), true);
});

test('community entry point never inherits a global GMGN key', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.mjs'), 'utf8');
  assert.match(main, /legacyKeyProvider:\s*\(\)\s*=>\s*''/);
});

test('public copy matches the risk-radar default mode', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const boundary = fs.readFileSync(path.join(root, 'docs/EDITION-BOUNDARY.md'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

  for (const copy of [readme, boundary, html]) {
    assert.match(copy, /默认模式：风险雷达/);
  }
  assert.match(readme, /不会抢跑、签名或下单/);
  assert.match(boundary, /early-discovery/);
  assert.match(boundary, /实验性只读能力/);
  for (const copy of [readme, boundary, html]) {
    assert.doesNotMatch(copy, /保证(?:发现|命中|盈利)|亚秒级狙击|稳赚/);
  }
});

function temporaryReleaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-release-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of ['src/config.mjs', 'src/product/mode.mjs', 'SECURITY.md', 'docs/RELEASE-CHECKLIST.md']) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  return directory;
}

function completeOwnerReview(directory) {
  const file = path.join(directory, 'docs/RELEASE-CHECKLIST.md');
  const checklist = fs.readFileSync(file, 'utf8')
    .replace(/\| (上游条款复核|数据保留策略|直接链上 RPC 的隐私与日志策略) \| [^|]+ \| [^|]+ \| [^|]+ \|/g,
      '| $1 | 已完成 | 项目所有者授权（Codex 代核） | 2026-09-23 |');
  fs.writeFileSync(file, checklist);
}

function pendingOwnerReview(directory) {
  const file = path.join(directory, 'docs/RELEASE-CHECKLIST.md');
  const checklist = fs.readFileSync(file, 'utf8')
    .replace(/\| (上游条款复核|数据保留策略|直接链上 RPC 的隐私与日志策略) \| [^|]+ \| [^|]+ \| [^|]+ \|/g,
      '| $1 | 待复核 | 待项目所有者 | 待定 |');
  fs.writeFileSync(file, checklist);
}

test('release artifact scan rejects runtime state, logs, paths, keys and private keys', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-release-sensitive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = new Map([
    ['state/events/2026-09-23.ndjson', '{}'],
    ['logs/radar.log', 'runtime log'],
    ['state/radar.json', '{}'],
    ['notes.md', `path=${['/Users/', 'private/', 'workspace'].join('')}`],
    ['runtime.json', JSON.stringify({ rpc: `https://eth-mainnet.alchemy.com/v2/${'a'.repeat(32)}` })],
    ['keys.txt', ['gmgn_', 'a'.repeat(32)].join('')],
    ['private.pem', ['-----BEGIN PRIVATE KEY-----\n', 'A'.repeat(64), '\n-----END PRIVATE KEY-----'].join('')]
  ]);
  for (const [file, content] of files) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  const codes = new Set(scanSensitiveArtifacts({ root: directory }).map(finding => finding.code));
  for (const code of [
    'FORBIDDEN_RUNTIME_PATH', 'RUNTIME_LOG', 'PERSONAL_ABSOLUTE_PATH',
    'RPC_SECRET', 'API_KEY', 'PRIVATE_KEY'
  ]) assert.equal(codes.has(code), true, `missing finding ${code}`);
});

test('compliance documents record upstream use, retention, redistribution and RPC privacy', () => {
  const security = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
  const checklist = fs.readFileSync(path.join(root, 'docs/RELEASE-CHECKLIST.md'), 'utf8');
  const productMode = fs.readFileSync(path.join(root, 'src/product/mode.mjs'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'src/config.mjs'), 'utf8');

  for (const heading of ['上游数据用途与保留', '数据保留与删除', '再分发边界', '直接链上 RPC 隐私', '授权复核记录']) {
    assert.match(security, new RegExp(`^## ${heading}$`, 'm'));
  }
  for (const source of ['GMGN', 'DexScreener', 'GoPlus', '直接链上 RPC']) assert.match(security, new RegExp(`\\| ${source} \\|`));
  assert.match(security, /15[–-]60\s*秒/);
  assert.match(security, /state\/events/);
  assert.match(security, /不得批量导出、公开再分发/);
  assert.match(security, /项目所有者授权（Codex 代核）/);
  for (const link of [
    'https://docs.gmgn.ai/index/gmgn-agent-api',
    'https://docs.dexscreener.com/api/reference',
    'https://docs.gopluslabs.io/reference/api-overview',
    'https://solana.com/docs/rpc'
  ]) assert.match(security, new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(checklist, /^## 所有者复核门禁$/m);
  for (const item of ['上游条款复核', '数据保留策略', '直接链上 RPC 的隐私与日志策略']) {
    assert.match(checklist, new RegExp(`\\| ${item} \\|`));
  }
  assert.match(config, /resolveProductMode\(process\.env\.RADAR_PRODUCT_MODE\s*\|\|\s*'risk-radar'\)/);
  assert.match(productMode, /'risk-radar':\s*Object\.freeze\(\{[\s\S]*?execution:\s*false/);
  assert.match(productMode, /'early-discovery':\s*Object\.freeze\(\{[\s\S]*?execution:\s*false/);
});

test('release audit passes only after owner review markers and all technical gates are complete', t => {
  const directory = temporaryReleaseFixture(t);
  pendingOwnerReview(directory);
  const pending = auditRelease({ root: directory });
  assert.equal(pending.ok, false);
  assert.equal(pending.checks.ownerReviewComplete, false);
  assert.equal(pending.findings.some(finding => finding.code === 'OWNER_REVIEW_PENDING'), true);

  completeOwnerReview(directory);
  const complete = auditRelease({ root: directory });
  assert.equal(complete.ok, true);
  assert.equal(complete.checks.productMode, 'risk-radar');
  assert.equal(complete.checks.executionDisabled, true);
  assert.equal(complete.checks.ownerReviewComplete, true);
  assert.deepEqual(complete.findings, []);
});
