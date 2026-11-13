import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../lib/logger';

mongoose.set('strictQuery', true);
// Operator injection is blocked earlier: every request body/query is parsed by a
// strict zod schema and the sanitize middleware strips `$`/`.` keys.

export async function connectDb(): Promise<typeof mongoose> {
  const conn = await mongoose.connect(env.MONGODB_URI, {
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    // Index builds are a controlled migration step in production (npm run sync-indexes).
    autoIndex: !env.isProd,
  });
  logger.info({ host: conn.connection.host, db: conn.connection.name }, 'MongoDB connected');
  return conn;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

/** True when the connected deployment supports multi-document transactions. */
export async function supportsTransactions(): Promise<boolean> {
  const admin = mongoose.connection.db?.admin();
  if (!admin) return false;
  try {
    const hello = (await admin.command({ hello: 1 })) as { setName?: string; msg?: string };
    return Boolean(hello.setName) || hello.msg === 'isdbgrid';
  } catch {
    return false;
  }
}
