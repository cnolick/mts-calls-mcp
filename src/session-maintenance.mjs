import { activeSession } from './auth-refresh.mjs';

// Refresh only when the existing expiry checks say it is due. Keep the
// recordings token alive even when no MCP tools are called for weeks.
export function startSessionMaintenance({ refresh = activeSession, intervalMs = 300000, onError = () => console.error('MTS session maintenance failed; will retry.') } = {}) {
  let busy = false, stopped = false;
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try { await refresh(); }
    catch { onError(); }
    finally { busy = false; }
  }
  const timer = setInterval(() => void tick(), intervalMs).unref();
  void tick();
  return { tick, close() { stopped = true; clearInterval(timer); } };
}
