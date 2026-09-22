export function sourceHealthRecord({ status, count = 0, latencyMs = 0, code = '', checkedAt = Date.now() }) {
  return { status, count, latencyMs, code, checkedAt };
}

export function summarizeSourceHealth(health = {}) {
  const rows = Object.values(health);
  return {
    complete: rows.length > 0 && rows.every(row => row.status === 'OK'),
    checkedAt: Math.max(0, ...rows.map(row => Number(row.checkedAt) || 0)),
    sources: health
  };
}
