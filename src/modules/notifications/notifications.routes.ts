import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { idParams } from '../../lib/schemas';
import { validate } from '../../middleware/validate';
import { Notification } from '../../models/Jobs';

export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const [items, unread] = await Promise.all([
      Notification.find({ recipientId: req.user!.id, channel: 'in_app' }).sort({ createdAt: -1 }).limit(20).select('title body link readAt createdAt').lean(),
      Notification.countDocuments({ recipientId: req.user!.id, channel: 'in_app', readAt: null }),
    ]);
    res.json({ items, unread });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await Notification.updateMany({ recipientId: req.user!.id, channel: 'in_app', readAt: null }, { $set: { readAt: new Date() } });
    res.status(204).end();
  }),
);

notificationsRouter.post(
  '/:id/read',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await Notification.updateOne({ _id: req.params.id, recipientId: req.user!.id }, { $set: { readAt: new Date() } });
    res.status(204).end();
  }),
);
