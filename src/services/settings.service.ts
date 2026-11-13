import { AppError } from '../lib/errors';
import { DEFAULT_SETTINGS, SystemSetting, type AppSettings } from '../models/SystemSetting';

const KEY = 'app';
const TTL_MS = 30_000;
let cache: { value: AppSettings; version: number; at: number } | null = null;

function merge(stored: Partial<AppSettings> | undefined): AppSettings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    business: { ...DEFAULT_SETTINGS.business, ...s.business },
    tax: { ...DEFAULT_SETTINGS.tax, ...s.tax },
    quotation: { ...DEFAULT_SETTINGS.quotation, ...s.quotation },
    trip: { ...DEFAULT_SETTINGS.trip, ...s.trip },
    compliance: { ...DEFAULT_SETTINGS.compliance, ...s.compliance },
    reminders: { ...DEFAULT_SETTINGS.reminders, ...s.reminders },
    reports: { ...DEFAULT_SETTINGS.reports, ...s.reports },
  };
}

/** Cached for 30 s per instance; writes invalidate the local cache immediately. */
export async function getSettings(): Promise<AppSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const doc = await SystemSetting.findById(KEY).lean();
  const value = merge(doc?.value);
  cache = { value, version: (doc as { __v?: number } | null)?.__v ?? 0, at: Date.now() };
  return value;
}

export async function getSettingsWithVersion(): Promise<{ value: AppSettings; version: number }> {
  cache = null;
  const value = await getSettings();
  return { value, version: cache!.version };
}

export async function saveSettings(next: AppSettings, version: number, userId: string): Promise<AppSettings> {
  let doc = await SystemSetting.findById(KEY);
  if (!doc) doc = new SystemSetting({ _id: KEY, value: DEFAULT_SETTINGS });
  else if (doc.__v !== version) throw AppError.stale();
  doc.value = next;
  doc.markModified('value');
  doc.set('updatedBy', userId);
  await doc.save();
  cache = null;
  return getSettings();
}
