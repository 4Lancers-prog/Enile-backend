import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { authenticate } from '../../middleware/auth';
import { loginLimiter } from '../../middleware/rateLimiters';
import { validate } from '../../middleware/validate';
import { User } from '../../models/User';
import { getSettings } from '../../services/settings.service';
import { changePasswordBody, loginBody } from './auth.schema';
import * as svc from './auth.service';

export const authRouter = Router();

authRouter.post(
  '/login',
  loginLimiter,
  validate({ body: loginBody }),
  asyncHandler(async (req, res) => {
    const user = await svc.login(req, res, req.body.email, req.body.password);
    res.json({ user });
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const user = await svc.refresh(req, res);
    res.json({ user });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await svc.logout(req, res);
    res.status(204).end();
  }),
);

/**
 * Bootstrap call: user, permissions and the UI-relevant settings in ONE request,
 * so the app shell renders without a waterfall of follow-up calls.
 */
authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const [user, settings] = await Promise.all([
      User.findById(req.user!.id).select('name email role mustChangePassword').lean(),
      getSettings(),
    ]);
    if (!user) return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Please sign in to continue.', requestId: req.id } });
    return res.json({
      user: svc.publicUser(user),
      settings: {
        timezone: settings.timezone,
        businessName: settings.business.name,
        homeStateCode: settings.business.homeStateCode,
        tax: { defaultRateBps: settings.tax.defaultRateBps, allowedRatesBps: settings.tax.allowedRatesBps, roundOffTotal: settings.tax.roundOffTotal },
        quotationValidityDays: settings.quotation.validityDays,
        trip: {
          shortageTolerancePercent: settings.trip.shortageTolerancePercent,
          requireSealsOnDispatch: settings.trip.requireSealsOnDispatch,
          requireProofOfDelivery: settings.trip.requireProofOfDelivery,
        },
      },
    });
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: changePasswordBody }),
  asyncHandler(async (req, res) => {
    await svc.changePassword(req, res, req.body.currentPassword, req.body.newPassword);
    res.status(204).end();
  }),
);
