/**
 * Controlled index migration (manual 3.3). Run during deployment, after checking
 * for duplicates that would block a new unique index:  npm run sync-indexes
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db';
import { logger } from '../lib/logger';
import '../models/AuditLog';
import '../models/Company';
import '../models/Counter';
import '../models/Document';
import '../models/Driver';
import '../models/IdempotencyKey';
import '../models/Jobs';
import '../models/Lead';
import '../models/Lock';
import '../models/Quotation';
import '../models/Session';
import '../models/SystemSetting';
import '../models/Trip';
import '../models/User';
import '../models/Vehicle';
import '../models/StockItem';
import '../models/StockMovement';
import '../models/Supplier';
import '../models/PurchaseOrder';
import '../models/TripExpense';
import '../models/DriverPayment';

async function main() {
  await connectDb();
  for (const name of mongoose.modelNames()) {
    const dropped = await mongoose.model(name).syncIndexes();
    logger.info({ model: name, dropped }, 'indexes synced');
  }
  await disconnectDb();
}

main().catch((err) => {
  logger.fatal({ err }, 'index sync failed');
  process.exit(1);
});
