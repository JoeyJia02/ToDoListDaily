import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CACHE_MS = 5 * 60 * 1000;
const MANUAL_INTERVAL_MS = 15 * 1000;
const TIMEOUT_MS = 20000;
const MAX_OUTPUT = 1024 * 1024;
const ERROR_CODES = new Set(['codex_unavailable', 'authentication', 'network', 'timeout', 'process_exit', 'invalid_response', 'no_windows', 'stopped', 'unknown']);
function usageError(code, text) { const error = new Error(text); error.usageCode = code; return error; }
function classifyError(error, stderr = '') {
  const text = `${typeof error === 'string' ? error : error?.message ?? ''}\n${stderr}`;
  if (/unauthori[sz]ed|unauthenticated|authentication|not logged in|log in|login required|session.{0,15}expired|\b401\b|\b403\b/i.test(text)) return 'authentication';
  if (/dns|network|connection (?:refused|reset|failed)|could not resolve|unreachable|tls|certificate|proxy error/i.test(text)) return 'network';
  if (/timed? ?out|timeout/i.test(text)) return 'timeout';
  return ERROR_CODES.has(error?.usageCode) ? error.usageCode : 'unknown';
}

// Only return the information needed by the card, never the full account response.
export function normalizeRateLimits(result) {
  const buckets = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
    ? Object.entries(result.rateLimitsByLimitId) : [];
  if (!buckets.length && result?.rateLimits) buckets.push([result.rateLimits.limitId || 'codex', result.rateLimits]);
  const windows = [];
  for (const [id, bucket] of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const rawLabel = typeof bucket.limitName === 'string' && bucket.limitName.trim() ? bucket.limitName : id;
    const label = String(rawLabel).slice(0, 80);
    for (const key of ['primary', 'secondary']) {
      const window = bucket[key];
      if (!window || typeof window !== 'object') continue;
      const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? window.usedPercent : null;
      const duration = typeof window.windowDurationMins === 'number' && Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : null;
      const reset = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null;
      windows.push({ label, remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)), windowDurationMins: duration, resetsAt: reset });
    }
  }
  return windows;
}

function codexCommand() {
  if (process.env.DAILY_PLANNER_CODEX) return process.env.DAILY_PLANNER_CODEX;
  // A launchd agent has a minimal PATH. Prefer a conventional CLI install, then
  // the executable distributed with the macOS app; neither path embeds a user.
  for (const path of ['/usr/local/bin/codex', '/opt/homebrew/bin/codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex']) {
    if (existsSync(path)) return path;
  }
  return 'codex';
}

export function readCodexLimits({ command = codexCommand(), timeoutMs = TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let buffer = ''; let stderr = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      if (child && !child.killed) child.kill();
      if (error) { error.usageCode = classifyError(error, stderr); reject(error); } else resolve(value);
    };
    const abort = () => finish(usageError('stopped', '读取已停止'));
    const timeout = setTimeout(() => finish(usageError('timeout', '读取超时')), timeoutMs);
    timeout.unref();
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try { child = spawn(command, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { finish(usageError('codex_unavailable', 'Codex 不可用')); return; }
    child.on('error', () => finish(usageError('codex_unavailable', 'Codex 不可用')));
    // Wait for stderr to drain before classifying a failed process. Never return,
    // persist, or print stderr because it may contain account or environment data.
    child.on('close', () => finish(usageError('process_exit', 'Codex 用量读取中断')));
    child.stdin.on('error', () => {}); // `close` records the failure after stderr drains.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (stderr.length < 16384) stderr += chunk.slice(0, 16384 - stderr.length); });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_OUTPUT) { finish(usageError('invalid_response', 'Codex 返回数据过大')); return; }
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error || !message.result) { const error = usageError('invalid_response', 'Codex 初始化失败'); error.usageCode = classifyError(message.error?.message ?? '', stderr) === 'unknown' ? 'invalid_response' : classifyError(message.error?.message ?? '', stderr); finish(error); return; }
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (message.id === 2) {
          if (message.error || !message.result) { const error = usageError('invalid_response', '无法读取 Codex 用量'); error.usageCode = classifyError(message.error?.message ?? '', stderr) === 'unknown' ? 'invalid_response' : classifyError(message.error?.message ?? '', stderr); finish(error); return; }
          finish(null, message.result); return;
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'todolist_usage', title: 'ToDoList', version: '1.0.0' } } });
  });
}

export function createCodexUsage({ query = readCodexLimits, now = () => Date.now(), cacheMs = CACHE_MS, manualIntervalMs = MANUAL_INTERVAL_MS } = {}) {
  let windows = []; let updatedAt = null; let lastAttempt = null; let failed = false; let errorCode = null; let pending = null; let closed = false;
  const controller = new AbortController();
  const snapshot = () => ({ available: updatedAt !== null, updatedAt: updatedAt === null ? null : new Date(updatedAt).toISOString(), windows, stale: updatedAt !== null && (failed || now() - updatedAt >= cacheMs), errorCode, refreshing: pending !== null });
  const trigger = () => {
    if (closed) return Promise.resolve(false);
    if (pending) return pending;
    lastAttempt = now();
    pending = Promise.resolve().then(() => query({ signal: controller.signal })).then(result => {
      if (closed) return false;
      const next = normalizeRateLimits(result);
      if (!next.length) throw usageError('no_windows', '没有可用的额度窗口');
      windows = next; updatedAt = now(); failed = false; errorCode = null; return true;
    }).catch(error => { if (!closed) { failed = true; errorCode = classifyError(error); } return false; }).finally(() => { pending = null; });
    return pending;
  };
  return {
    read() {
      if (!closed && !pending && (lastAttempt === null || now() - lastAttempt >= cacheMs)) void trigger();
      return snapshot();
    },
    async refresh() {
      if (closed) return {...snapshot(), refreshStatus: 'failed', errorCode: 'stopped'};
      if (pending) { const ok = await pending; return {...snapshot(), refreshStatus: ok ? 'updated' : 'failed'}; }
      const elapsed = lastAttempt === null ? Infinity : now() - lastAttempt;
      if (elapsed < manualIntervalMs) return {...snapshot(), refreshStatus: 'throttled', retryAfterSeconds: Math.max(1, Math.ceil((manualIntervalMs - elapsed) / 1000))};
      const ok = await trigger();
      return {...snapshot(), refreshStatus: ok ? 'updated' : 'failed'};
    },
    close() { closed = true; controller.abort(); },
  };
}
