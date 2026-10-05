import type { RuntimeConfig } from './runtime.js';

const DAY = 86_400_000;

/** Most recent daily 04:00 UTC run, including a missed run after a restart. */
export function retentionWindow(now: number) {
  return Math.floor((now - 4 * 3_600_000) / DAY) * DAY + 4 * 3_600_000;
}

export async function createRetentionScheduler(
  config: RuntimeConfig,
  purge: () => Promise<unknown>,
) {
  await config.db.migrate(`CREATE TABLE IF NOT EXISTS rove_retention_schedule (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_run BIGINT NOT NULL
  )`);
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  async function tick(now = Date.now()) {
    if (stopped || running) return;
    running = (async () => {
      await config.state.assertOwned();
      const window = retentionWindow(now);
      const row = await config.db.get(
        'SELECT last_run FROM rove_retention_schedule WHERE singleton=1',
      );
      if (Number(row?.last_run ?? 0) >= window) return;
      await purge();
      if (stopped) return;
      await config.state.assertOwned();
      await config.db.run(
        'INSERT INTO rove_retention_schedule VALUES(1,$1) ON CONFLICT(singleton) DO UPDATE SET last_run=excluded.last_run',
        [window],
      );
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  }
  const attempt = () => {
    void tick().catch(() =>
      console.error(
        'Conversation retention will retry; existing work is unaffected.',
      ),
    );
  };
  function cancelPending() {
    stopped = true;
    if (timer) clearInterval(timer);
  }
  return {
    tick,
    start() {
      if (stopped || timer) return;
      timer = setInterval(attempt, 60_000);
      timer.unref();
    },
    cancelPending,
    async close() {
      cancelPending();
      await running?.catch(() => {});
    },
  };
}
