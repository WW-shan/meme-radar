import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    // Only valid JSON can replace the last known good backup.
    if (fs.existsSync(file)) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.copyFileSync(file, `${file}.bak`);
        fs.chmodSync(`${file}.bak`, 0o600);
      } catch {}
    }
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function readJsonWithBackup(file, fallback) {
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) return { value: structuredClone(fallback), recovered: false };
  for (const [target, recovered] of [[file, false], [`${file}.bak`, true]]) {
    try {
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      return { value, recovered };
    } catch {}
  }
  // Do not overwrite unreadable user history with a silent empty reset.
  throw Object.assign(new Error('本地记录与备份均无法读取，请保留文件后检查。'), { code: 'STATE_CORRUPT' });
}

export function tokenKey(chain, address) {
  const value = String(address || '').trim();
  return `${chain}:${chain === 'sol' ? value : value.toLowerCase()}`;
}

function validAnnotationAddress(chain, address) {
  return chain === 'sol'
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
    : /^0x[0-9a-f]{40}$/i.test(address);
}

function sanitizeNote(note) {
  return note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function normalizeAnnotations(raw, chains) {
  const annotations = {};
  for (const value of Object.values(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const chain = String(value.chain || '').toLowerCase();
    const address = String(value.address || '').trim();
    if (!chains.includes(chain) || !validAnnotationAddress(chain, address)
      || typeof value.favorite !== 'boolean' || typeof value.note !== 'string' || value.note.length > 500) continue;
    annotations[tokenKey(chain, address)] = {
      chain,
      address,
      favorite: value.favorite,
      note: sanitizeNote(value.note),
      updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0
    };
  }
  return annotations;
}

export class RadarControls {
  constructor(dir, chains, initialChain) {
    this.file = path.join(dir, 'preferences.json');
    this.chains = chains;
    const defaults = { enabledChains: [initialChain], annotations: {} };
    const loaded = readJsonWithBackup(this.file, defaults).value;
    const enabledChains = Array.isArray(loaded.enabledChains) ? loaded.enabledChains : defaults.enabledChains;
    this.value = {
      enabledChains: [...new Set(enabledChains)].filter(x => chains.includes(x)).slice(0, 3),
      annotations: normalizeAnnotations(loaded.annotations, chains)
    };
    if (!this.value.enabledChains.length) this.value.enabledChains = [initialChain];
  }
  setChains(chains) {
    if (!Array.isArray(chains) || !chains.length || chains.length > 3 || new Set(chains).size !== chains.length || chains.some(x => !this.chains.includes(x))) {
      throw Object.assign(new Error('invalid_selection'), { statusCode: 400 });
    }
    this.value.enabledChains = [...chains];
    atomicJson(this.file, this.value);
    return { enabledChains: this.value.enabledChains };
  }
  annotate({ chain, address, favorite, note }) {
    if (!this.chains.includes(chain) || typeof address !== 'string'
      || !validAnnotationAddress(chain, address)
      || typeof favorite !== 'boolean' || typeof note !== 'string' || note.length > 500) {
      throw Object.assign(new Error('invalid_annotation'), { statusCode: 400 });
    }
    const key = tokenKey(chain, address);
    if (favorite && !this.value.annotations[key]?.favorite && Object.values(this.value.annotations).filter(row => row.favorite).length >= 50) {
      throw Object.assign(new Error('favorite_limit'), { statusCode: 400 });
    }
    if (!this.value.annotations[key] && Object.keys(this.value.annotations).length >= 500) throw Object.assign(new Error('annotation_limit'), { statusCode: 400 });
    this.value.annotations[key] = { chain, address, favorite, note: sanitizeNote(note), updatedAt: Date.now() };
    if (!favorite && !note.trim()) delete this.value.annotations[key];
    atomicJson(this.file, this.value);
    return { saved: true };
  }
}
