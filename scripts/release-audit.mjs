import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', 'node_modules']);
const secretFiles = new Set(['.env', '.npmrc', 'ave-credentials.json', 'gmgn-api-key', 'agent-private-key']);
const runtimeDirectories = new Set(['state', '.runtime', '.local-data', 'coverage', 'dist']);
const runtimeFiles = new Set(['radar.json', 'radar.json.bak']);
const textExtensions = new Set(['', '.bat', '.command', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ndjson', '.sh', '.txt', '.yml', '.yaml']);
const ownerReviewItems = Object.freeze([
  '上游条款复核', '数据保留策略', '直接链上 RPC 的隐私与日志策略'
]);

export const REVIEW_ITEMS = ownerReviewItems;

function finding(code, relative, message) {
  return { code, path: relative, message };
}

function relativePath(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function isPlaceholder(value) {
  return /^(?:<[^>]+>|your|example|placeholder|changeme|replace|redacted|dummy|test)[-_A-Za-z0-9]*$/i.test(value);
}

function rpcSecret(content) {
  const providerPatterns = [
    /https?:\/\/(?:[^\s/]+\.)?alchemy\.com\/v2\/([A-Za-z0-9_-]{16,})/i,
    /https?:\/\/(?:[^\s/]+\.)?infura\.io\/v3\/([A-Za-z0-9_-]{16,})/i,
    /https?:\/\/(?:[^\s/]+\.)?helius-rpc\.com\/[^\s'"`<>)]*[?&]api-key=([A-Za-z0-9_-]{16,})/i
  ];
  for (const pattern of providerPatterns) {
    const match = content.match(pattern);
    if (match && !isPlaceholder(match[1])) return match[0];
  }
  for (const candidate of content.matchAll(/https?:\/\/[^\s'"`<>)]*[?&](?:api[-_]?key|apikey|token|key)=([A-Za-z0-9_-]{20,})/gi)) {
    if (!isPlaceholder(candidate[1])) return candidate[0];
  }
  return '';
}

export function scanSensitiveArtifacts({ root = projectRoot } = {}) {
  const findings = [];
  const add = (code, absolute, message) => findings.push(finding(code, relativePath(root, absolute), message));

  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = relativePath(root, absolute);
      const segments = relative.split('/');
      const first = segments[0];
      const lowerName = entry.name.toLowerCase();
      const extension = path.extname(entry.name).toLowerCase();

      if (first === 'logs' || lowerName.endsWith('.log') || lowerName === 'npm-debug.log') {
        add('RUNTIME_LOG', absolute, '发布包不得包含日志。');
      }
      if (runtimeDirectories.has(first) || relative === 'state/events') {
        add('FORBIDDEN_RUNTIME_PATH', absolute, '发布包不得包含运行状态、事件库或构建目录。');
      }
      if (secretFiles.has(lowerName)) add('FORBIDDEN_SECRET_FILE', absolute, '发布包不得包含本机密钥或环境配置。');
      if (runtimeFiles.has(lowerName) || /\.(?:tmp|bak|swp)$/i.test(lowerName)) {
        add('RUNTIME_STATE_FILE', absolute, '发布包不得包含运行状态、临时文件或备份。');
      }
      if (extension === '.pem' || extension === '.key' || extension === '.p12' || /private[-_]?key/i.test(lowerName)) {
        add('PRIVATE_KEY', absolute, '发布包不得包含私钥文件。');
      }

      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!textExtensions.has(extension) || entry.name === 'package-lock.json') continue;
      const content = fs.readFileSync(absolute, 'utf8');
      if (/\/(?:Users|home)\/[^/\s'"`]+\//.test(content) || /[A-Z]:\\Users\\[^\\\s'"`]+\\/i.test(content)) {
        add('PERSONAL_ABSOLUTE_PATH', absolute, '发布包不得包含个人电脑绝对路径。');
      }
      if (rpcSecret(content)) add('RPC_SECRET', absolute, '发布包不得包含真实 RPC 凭据或带密钥的 RPC 地址。');
      if (/gmgn_[a-z0-9]{20,}/i.test(content) || /(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/.test(content)) {
        add('API_KEY', absolute, '发布包不得包含真实 API Key。');
      }
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{40,}/.test(content)) {
        add('PRIVATE_KEY', absolute, '发布包不得包含私钥正文。');
      }
    }
  }

  visit(root);
  return findings;
}

function checkProductMode(root) {
  const findings = [];
  const configPath = path.join(root, 'src/config.mjs');
  const modePath = path.join(root, 'src/product/mode.mjs');
  let productMode = '';
  let executionDisabled = false;
  try {
    const config = fs.readFileSync(configPath, 'utf8');
    const mode = fs.readFileSync(modePath, 'utf8');
    const defaultMatch = config.match(/resolveProductMode\(process\.env\.RADAR_PRODUCT_MODE\s*\|\|\s*'([^']+)'\)/);
    productMode = defaultMatch?.[1] || '';
    const riskBlock = mode.match(/'risk-radar':\s*Object\.freeze\(\{([\s\S]*?)\}\),\s*'early-discovery'/);
    const earlyBlock = mode.match(/'early-discovery':\s*Object\.freeze\(\{([\s\S]*?)\}\s*\)/);
    executionDisabled = /execution:\s*false/.test(riskBlock?.[1] || '') && /execution:\s*false/.test(earlyBlock?.[1] || '');
    if (productMode !== 'risk-radar') findings.push(finding('PRODUCT_MODE_UNSAFE', 'src/config.mjs', '默认产品模式必须是 risk-radar。'));
    if (!executionDisabled) findings.push(finding('EXECUTION_ENABLED', 'src/product/mode.mjs', '所有产品模式的执行能力必须保持关闭。'));
  } catch {
    findings.push(finding('PRODUCT_MODE_UNREADABLE', 'src', '无法读取产品模式或执行能力定义。'));
  }
  return { findings, productMode, executionDisabled };
}

function parseOwnerReview(checklist) {
  const rows = new Map();
  for (const line of checklist.split('\n')) {
    const match = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (match) rows.set(match[1], { status: match[2], reviewer: match[3], date: match[4] });
  }
  return Object.fromEntries(ownerReviewItems.map(item => [item, rows.get(item) || null]));
}

function checkComplianceDocuments(root) {
  const findings = [];
  const securityPath = path.join(root, 'SECURITY.md');
  const checklistPath = path.join(root, 'docs/RELEASE-CHECKLIST.md');
  let security = '';
  let checklist = '';
  try { security = fs.readFileSync(securityPath, 'utf8'); } catch {}
  try { checklist = fs.readFileSync(checklistPath, 'utf8'); } catch {}

  const requiredHeadings = ['上游数据用途与保留', '数据保留与删除', '再分发边界', '直接链上 RPC 隐私', '授权复核记录'];
  for (const heading of requiredHeadings) {
    if (!new RegExp(`^## ${heading}$`, 'm').test(security)) {
      findings.push(finding('DATA_USE_RECORDS_MISSING', 'SECURITY.md', `缺少“${heading}”记录。`));
    }
  }
  for (const source of ['GMGN', 'DexScreener', 'GoPlus', '直接链上 RPC']) {
    if (!new RegExp(`\\| ${source} \\|`).test(security)) {
      findings.push(finding('DATA_USE_RECORDS_MISSING', 'SECURITY.md', `缺少 ${source} 数据用途记录。`));
    }
  }
  for (const required of [/15[–-]60\s*秒/, /state\/events/, /不得批量导出、公开再分发/]) {
    if (!required.test(security)) findings.push(finding('DATA_USE_RECORDS_MISSING', 'SECURITY.md', `缺少数据保留或再分发约束：${required}`));
  }
  for (const evidence of [
    'https://docs.gmgn.ai/index/gmgn-agent-api',
    'https://docs.dexscreener.com/api/reference',
    'https://docs.gopluslabs.io/reference/api-overview',
    'https://solana.com/docs/rpc'
  ]) {
    if (!security.includes(evidence)) findings.push(finding('DATA_USE_RECORDS_MISSING', 'SECURITY.md', `缺少官方复核证据：${evidence}`));
  }
  if (!/项目所有者授权（Codex 代核）/.test(security)) {
    findings.push(finding('DATA_USE_RECORDS_MISSING', 'SECURITY.md', '缺少所有者授权代核记录。'));
  }

  const review = parseOwnerReview(checklist);
  const incomplete = ownerReviewItems.filter(item => {
    const row = review[item];
    return !row || row.status !== '已完成'
      || !/所有者授权|项目所有者.*代核/.test(row.reviewer)
      || row.reviewer.includes('待') || !/^\d{4}-\d{2}-\d{2}$/.test(row.date);
  });
  if (ownerReviewItems.some(item => new RegExp(`^\\|\\s*${item}\\s*\\|\\s*待复核\\s*\\|`, 'm').test(checklist))) {
    findings.push(finding('OWNER_REVIEW_PENDING', 'docs/RELEASE-CHECKLIST.md', '发布清单仍含待复核占位。'));
  }
  if (incomplete.length) findings.push(finding('OWNER_REVIEW_PENDING', 'docs/RELEASE-CHECKLIST.md', `所有者复核未完成：${incomplete.join('、')}`));
  return { findings, review, ownerReviewComplete: incomplete.length === 0 };
}

export function auditRelease({ root = projectRoot, requireOwnerReview = true } = {}) {
  const sensitiveFindings = scanSensitiveArtifacts({ root });
  const product = checkProductMode(root);
  const compliance = checkComplianceDocuments(root);
  const findings = [...sensitiveFindings, ...product.findings, ...compliance.findings];
  if (!requireOwnerReview) {
    for (let index = findings.length - 1; index >= 0; index--) {
      if (findings[index].code === 'OWNER_REVIEW_PENDING') findings.splice(index, 1);
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    checks: {
      sensitiveArtifactsClear: sensitiveFindings.length === 0,
      productMode: product.productMode,
      executionDisabled: product.executionDisabled,
      dataUseRecordsComplete: !compliance.findings.some(row => row.code === 'DATA_USE_RECORDS_MISSING'),
      ownerReviewComplete: compliance.ownerReviewComplete
    },
    ownerReview: compliance.review
  };
}

function main() {
  const result = auditRelease();
  if (!result.ok) {
    console.error('发布审计未通过：');
    for (const row of result.findings) console.error(`- [${row.code}] ${row.path}：${row.message}`);
    process.exitCode = 1;
    return;
  }
  console.log('发布审计通过：运行内容、默认模式、执行边界、数据用途、保留策略和所有者复核均已满足。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
