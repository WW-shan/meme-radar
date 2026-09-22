export class JsonRpcClient {
  constructor(url, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, headers = {} } = {}) {
    this.url = String(url || '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.headers = headers;
  }

  configured() {
    return Boolean(this.url && typeof this.fetchImpl === 'function');
  }

  async call(method, params = []) {
    if (!this.configured()) {
      throw Object.assign(new Error('chain RPC is not configured'), { code: 'CHAIN_SOURCE_UNCONFIGURED' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal
      });
      if (!response?.ok) throw Object.assign(new Error('chain RPC request failed'), { code: 'CHAIN_RPC_ERROR' });
      const payload = await response.json();
      if (payload?.error) throw Object.assign(new Error(payload.error.message || 'chain RPC error'), { code: 'CHAIN_RPC_ERROR' });
      return payload?.result;
    } catch (error) {
      if (error?.name === 'AbortError') throw Object.assign(new Error('chain RPC timeout'), { code: 'CHAIN_RPC_TIMEOUT' });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
