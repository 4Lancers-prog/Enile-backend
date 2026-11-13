import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { loadForUpdate, withVersion } from '../../lib/crud';
import { AppError, ErrorCodes } from '../../lib/errors';
import { escapeRegex } from '../../lib/normalize';
import { paginate } from '../../lib/pagination';
import { idParams } from '../../lib/schemas';
import { authorize, invalidateUserCache } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../config/permissions';
import { Session } from '../../models/Session';
import { User } from '../../models/User';
import { audit, diffFields } from '../../services/audit.service';
import { hashPassword } from '../auth/password';
import { createUserBody, listUsersQuery, resetPasswordBody, updateUserBody } from './users.schema';
import type { z } from 'zod';

export const usersRouter = Router();
usersRouter.use(authorize('users.manage'));

const PUBLIC_FIELDS = 'name email phone role status lastLoginAt mustChangePassword createdAt updatedAt __v';

/** Read-only role → permission matrix, shown on the Users screen. */
usersRouter.get('/roles', (_req, res) => {
  res.json({ permissions: PERMISSIONS, roles: ROLE_PERMISSIONS });
});

usersRouter.get(
  '/',
  validate({ query: listUsersQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, q, role, status } = req.query as unknown as z.infer<typeof listUsersQuery>;
    const filter: Record<string, unknown> = {};
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (q) filter.$or = [{ email: new RegExp('^' + escapeRegex(q.toLowerCase())) }, { name: new RegExp(escapeRegex(q), 'i') }];
    const result = await paginate(User, { filter, page, limit, sort: { createdAt: -1 }, projection: PUBLIC_FIELDS });
    res.json({ ...result, items: (result.items as { __v?: number }[]).map(withVersion) });
  }),
);

usersRouter.post(
  '/',
  validate({ body: createUserBody }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createUserBody>;
    const user = await User.create({
      name: body.name,
      email: body.email,
      phone: body.phone,
      role: body.role,
      passwordHash: await hashPassword(body.password),
      mustChangePassword: true,
      createdBy: req.user!.id,
    });
    await audit(req, { action: 'user.create', entityType: 'user', entityId: String(user._id), meta: { role: body.role } });
    res.status(201).json(withVersion((await User.findById(user._id).select(PUBLIC_FIELDS).lean())!));
  }),
);

/** Prevents demoting or disabling the only active administrator (manual 4.1). */
async function assertNotLastAdmin(userId: string) {
  const others = await User.countDocuments({ _id: { $ne: userId }, role: 'admin', status: 'active' });
  if (others === 0) throw AppError.unprocessable(ErrorCodes.LAST_ADMIN, 'Add another active administrator before changing this account.');
}

usersRouter.patch(
  '/:id',
  validate({ params: idParams, body: updateUserBody }),
  asyncHandler(async (req, res) => {
    const { version, ...patch } = req.body as z.infer<typeof updateUserBody>;
    const user = await loadForUpdate(User, req.params.id, version, 'User');
    const demoting = user.role === 'admin' && patch.role && patch.role !== 'admin';
    const disabling = user.role === 'admin' && patch.status === 'disabled';
    if ((demoting || disabling) && user.status === 'active') await assertNotLastAdmin(String(user._id));
    if (String(user._id) === req.user!.id && patch.status === 'disabled') throw AppError.unprocessable(ErrorCodes.LAST_ADMIN, 'You cannot disable your own account.');

    const changed = diffFields(user.toObject(), patch);
    user.set(patch);
    if (changed.includes('role') || changed.includes('status')) user.tokenVersion += 1; // forces re-login
    await user.save();
    invalidateUserCache(String(user._id));
    if (patch.status === 'disabled') await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit(req, { action: changed.includes('role') ? 'user.permission_change' : 'user.update', entityType: 'user', entityId: String(user._id), changedFields: changed });
    res.json(withVersion((await User.findById(user._id).select(PUBLIC_FIELDS).lean())!));
  }),
);

usersRouter.post(
  '/:id/reset-password',
  validate({ params: idParams, body: resetPasswordBody }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw AppError.notFound('User');
    user.passwordHash = await hashPassword(req.body.password);
    user.mustChangePassword = true;
    user.tokenVersion += 1;
    await user.save();
    invalidateUserCache(String(user._id));
    await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit(req, { action: 'user.reset_password', entityType: 'user', entityId: String(user._id) });
    res.status(204).end();
  }),
);
