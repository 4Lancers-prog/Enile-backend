import { connectDb, disconnectDb } from './config/db';
import { env } from './config/env';
import { logger } from './lib/logger';
import { withLocks } from './lib/locks';
import { expireQuotations, scanRenewals } from './jobs/scheduler';
import { processJob, processNotification, processRenewalJob } from './jobs/processors';

/**
 * Background worker (manual 6): reminders, notifications, PDFs and exports run
 * here so they never hold up user requests. Safe to run several instances:
 * jobs are claimed atomically with leases and the scheduler is lock-guarded.
 */
let running = true;
const BATCH = 20;

async function drain(fn: () => Promise<boolean>) {
  for (let i = 0; i < BATCH && running; i++) if (!(await fn())) break;
}

async function tick() {
  await drain(processRenewalJob);
  await drain(processNotification);
  await drain(processJob);
}

async function schedule() {
  try {
    await withLocks(['scheduler:daily'], async () => {
      await scanRenewals();
      await expireQuotations();
    }, 5 * 60_000);
  } catch (err) {
    logger.warn({ err }, 'scheduler run skipped');
  }
}

async function main() {
  await connectDb();
  logger.info('worker started');
  await schedule();
  const schedTimer = setInterval(schedule, env.SCHEDULER_INTERVAL_MIN * 60_000);
  while (running) {
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, 'worker tick failed');
    }
    await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
  }
  clearInterval(schedTimer);
  await disconnectDb();
  process.exit(0);
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    logger.info({ sig }, 'worker stopping');
    running = false;
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
