import { execFile } from "node:child_process";

export type Notify = (fields: readonly string[], environment: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<void>;

/** A fixed executable, fixed fields and minimal environment: no account grants reach this helper. */
export const notifySystemd: Notify = (fields, environment, signal) => new Promise((resolve, reject) => {
  execFile("/usr/bin/systemd-notify", [...fields], {
    env: environment, signal, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 4096,
  }, error => error ? reject(new Error("Service notification failed.")) : resolve());
});

interface WatchdogOptions {
  environment?: NodeJS.ProcessEnv;
  notify?: Notify;
  onFailure?: () => void;
  schedule?: (callback: () => void, intervalMs: number) => () => void;
}

/** The heartbeat runs on the bot event loop, independent of every remote provider. */
export function startRuntimeWatchdog(options: WatchdogOptions = {}): () => void {
  const input = options.environment ?? process.env;
  if (!input.NOTIFY_SOCKET) return () => {};
  const environment = { NOTIFY_SOCKET: input.NOTIFY_SOCKET, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  const notify = options.notify ?? notifySystemd;
  const watchdogUsec = Number(input.WATCHDOG_USEC);
  const watchdog = Number.isFinite(watchdogUsec) && watchdogUsec > 0 && (!input.WATCHDOG_PID || input.WATCHDOG_PID === String(process.pid));
  const intervalMs = watchdog ? Math.max(100, Math.min(10_000, Math.floor(watchdogUsec / 2000))) : 10_000;
  const schedule = options.schedule ?? ((callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds); timer.unref();
    return () => clearInterval(timer);
  });
  const abort = new AbortController();
  let stopped = false, busy = false, ready = false, reported = false;
  async function pulse(): Promise<void> {
    if (stopped || busy || (ready && !watchdog)) return;
    busy = true;
    try {
      await notify([...(ready ? [] : ["READY=1"]), ...(watchdog ? ["WATCHDOG=1"] : [])], environment, abort.signal);
      ready = true; reported = false;
    } catch {
      if (!stopped && !reported) { reported = true; options.onFailure?.(); }
    } finally { busy = false; }
  }
  const cancel = schedule(() => { void pulse(); }, intervalMs);
  void pulse();
  return () => { stopped = true; cancel(); abort.abort(); };
}
