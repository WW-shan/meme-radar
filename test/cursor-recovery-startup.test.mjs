import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

function isolatedCopy(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-cursor-startup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const item of ['src', 'public', 'package.json']) {
    fs.cpSync(path.join(root, item), path.join(directory, item), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(directory, 'state'));
  fs.writeFileSync(path.join(directory, 'state/chain-cursors.json'),
    JSON.stringify({ version: 1, cursors: { 'evm-bsc-pool': -5 } }));
  return directory;
}

function isolatedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.startsWith('GMGN_')) delete env[key];
  return env;
}

async function runOnce(directory, env) {
  return exec(process.execPath, [path.join(directory, 'src/main.mjs'), '--once'], {
    cwd: directory, env, timeout: 30_000
  }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch(error => ({ code: error.code ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' }));
}

test('a corrupt chain cursor file cannot stop the read-only radar from starting', async t => {
  const directory = isolatedCopy(t);
  const result = await runOnce(directory, isolatedEnv());

  assert.ok(!/CHAIN_CURSOR_CORRUPT/.test(result.stderr), `startup must survive a corrupt cursor file:\n${result.stderr}`);
  assert.match(result.stdout, /"status"/, 'the once-cycle must still run and report a status');
  assert.equal(result.code, 0, 'a corrupt cursor file must not fail the read-only cycle');
  const entries = fs.readdirSync(path.join(directory, 'state'));
  assert.deepEqual(entries.filter(name => name.includes('.corrupt-')), [],
    'a disabled chain-events feature must not touch runtime state');
  assert.equal(fs.readFileSync(path.join(directory, 'state/chain-cursors.json'), 'utf8'),
    JSON.stringify({ version: 1, cursors: { 'evm-bsc-pool': -5 } }), 'the corrupt file is left untouched while the feature is off');
});

test('a corrupt chain cursor file also recovers when chain events are enabled', async t => {
  const directory = isolatedCopy(t);
  const result = await runOnce(directory, isolatedEnv({ RADAR_CHAIN_EVENTS: '1' }));

  assert.ok(!/CHAIN_CURSOR_CORRUPT/.test(result.stderr), `startup must survive a corrupt cursor file:\n${result.stderr}`);
  assert.match(result.stdout, /"status"/, 'chain sources without RPC URLs must report UNCONFIGURED instead of crashing');
  assert.match(result.stdout + result.stderr, /链上扫描游标文件损坏/);
});
