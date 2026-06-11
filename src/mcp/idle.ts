// Self-reaping for abandoned stdio servers. Clients that crash or forget their
// MCP children leave them alive with stdin open (observed: 147 stale instances
// under one desktop app), so EOF handling cannot fix the leak — only an idle
// timer can. A timeout of 0 disables the behavior entirely.
export interface IdleExitOptions {
  timeoutMs: number;
  onIdle: () => void;
  intervalMs?: number;
  now?: () => number;
}

export interface IdleExit {
  readonly enabled: boolean;
  touch(): void;
  tick(): void;
  stop(): void;
}

export function createIdleExit(options: IdleExitOptions): IdleExit {
  const now = options.now ?? Date.now;
  const enabled = options.timeoutMs > 0;
  let lastActivity = now();
  let fired = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = (): void => {
    if (!enabled || fired) {
      return;
    }
    if (now() - lastActivity > options.timeoutMs) {
      fired = true;
      stop();
      options.onIdle();
    }
  };

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  if (enabled && options.intervalMs !== undefined) {
    timer = setInterval(tick, options.intervalMs);
    // The timer must never be what keeps the process alive after stdin closes.
    timer.unref();
  }

  return {
    enabled,
    touch(): void {
      lastActivity = now();
    },
    tick,
    stop
  };
}
