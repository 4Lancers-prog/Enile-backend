import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { authorize } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import type { AppSettings } from '../../models/SystemSetting';
import { audit, diffFields } from '../../services/audit.service';
import { getSettingsWithVersion, saveSettings } from '../../services/settings.service';
import { settingsBody } from './settings.schema';

export const settingsRouter = Router();
settingsRouter.use(authorize('settings.manage'));

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await getSettingsWithVersion());
  }),
);

settingsRouter.put(
  '/',
  validate({ body: settingsBody }),
  asyncHandler(async (req, res) => {
    const before = (await getSettingsWithVersion()).value;
    const next = req.body.value as AppSettings;
    // Any tax change bumps the tax configuration version recorded on quotations.
    if (JSON.stringify({ ...before.tax, configVersion: 0 }) !== JSON.stringify({ ...next.tax, configVersion: 0 })) {
      next.tax.configVersion = before.tax.configVersion + 1;
    }
    await saveSettings(next, req.body.version, req.user!.id);
    await audit(req, { action: 'settings.update', entityType: 'settings', entityId: 'app', changedFields: diffFields(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>) });
    res.json(await getSettingsWithVersion());
  }),
);
