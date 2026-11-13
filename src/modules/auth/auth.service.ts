import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { permissionsFor } from '../../config/permissions';
import { AppError, ErrorCodes } from '../../lib/errors';
import { randomToken, sha256, signAccessToken } from '../../lib/tokens';
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE, invalidateUserCache } from '../../middleware/auth';
import { Session } from '../../models/Session';
import { User, type IUser } from '../../models/User';
import { audit } from '../../services/audit.service';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REFRESH_PATH = '/api/v1/auth';

const baseCookie = () => ({ secure: env.COOKIE_SECURE, sameSite: 'strict' as const });

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie(), httpOnly: true, path: '/', maxAge: env.ACCESS_TOKEN_TTL_MIN * 60_000 });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie(),
    httpOnly: true,
    path: REFRESH_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
  res.cookie(CSRF_COOKIE, randomToken(24), { ...baseCookie(), httpOnly: false, path: '/', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: REFRESH_PATH });
  res.clearCookie(CSRF_COOKIE, { ...baseCookie(), path: '/' });
}

async function issueSession(req: Request, res: Response, user: Pick<IUser, '_id' | 'role' | 'tokenVersion'>, family?: string) {
  const refreshToken = randomToken();
  const fam = family ?? randomToken(16);
  await Session.create({
    userId: user._id,
    tokenHash: sha256(refreshToken),
    family: fam,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    userAgent: req.get('user-agent')?.slice(0, 300),
    ip: req.ip,
  });
  const accessToken = signAccessToken({ sub: String(user._id), role: user.role, tv: user.tokenVersion });
  setAuthCookies(res, accessToken, refreshToken);
  return refreshToken;
}

export function publicUser(u: Pick<IUser, '_id' | 'name' | 'email' | 'role' | 'mustChangePassword'>) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    permissions: permissionsFor(u.role),
  };
}

export async function login(req: Request, res: Response, email: string, password: string) {
  const user = await User.findOne({ email }).select('+passwordHash +failedLoginCount +lockedUntil');
  if (!user) {
    await burnPasswordCheck(password);
    await audit(req, { action: 'auth.login', entityType: 'user', outcome: 'failure', meta: { reason: 'unknown_email' }, actorName: email });
    throw new AppError(401, ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Email or password is incorrect.');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(429, ErrorCodes.AUTH_ACCOUNT_LOCKED, `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes.`);
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    const failed = (user.failedLoginCount ?? 0) + 1;
    await User.updateOne(
      { _id: user._id },
      failed >= MAX_FAILED
        ? { $set: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } }
        : { $set: { failedLoginCount: failed } },
    );
    await audit(req, { action: 'auth.login', entityType: 'user', entityId: String(user._id), outcome: 'failure', actorId: String(user._id), actorName: user.name, meta: { reason: 'bad_password', failed } });
    throw new AppError(401, ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Email or password is incorrect.');
  }
  if (user.status !== 'active') {
    throw new AppError(403, ErrorCodes.AUTH_ACCOUNT_DISABLED, 'This account is disabled. Contact the administrator.');
  }
  await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  await issueSession(req, res, user);
  await audit(req, { action: 'auth.login', entityType: 'user', entityId: String(user._id), actorId: String(user._id), actorName: user.name });
  return publicUser(user);
}

export async function refresh(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw new AppError(401, ErrorCodes.AUTH_REQUIRED, 'Please sign in to continue.');
  const session = await Session.findOne({ tokenHash: sha256(token) });
  if (!session) {
    clearAuthCookies(res);
    throw new AppError(401, ErrorCodes.AUTH_REQUIRED, 'Your session has expired. Please sign in again.');
  }
  if (session.revokedAt || session.replacedByHash) {
    // Reuse of a rotated token: assume theft and revoke the whole family.
    await Session.updateMany({ family: session.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit(req, { action: 'auth.refresh_reuse', entityType: 'user', entityId: String(session.userId), outcome: 'failure', actorId: String(session.userId) });
    clearAuthCookies(res);
    throw new AppError(401, ErrorCodes.AUTH_REQUIRED, 'Your session has expired. Please sign in again.');
  }
  if (session.expiresAt < new Date()) {
    clearAuthCookies(res);
    throw new AppError(401, ErrorCodes.AUTH_REQUIRED, 'Your session has expired. Please sign in again.');
  }
  const user = await User.findById(session.userId);
  if (!user || user.status !== 'active') {
    await Session.updateOne({ _id: session._id }, { $set: { revokedAt: new Date() } });
    clearAuthCookies(res);
    throw new AppError(401, ErrorCodes.AUTH_REQUIRED, 'Please sign in to continue.');
  }
  const newToken = await issueSession(req, res, user, session.family);
  // Conditional update guards against two tabs refreshing with the same token at once.
  const rotated = await Session.updateOne({ _id: session._id, replacedByHash: null }, { $set: { replacedByHash: sha256(newToken), revokedAt: new Date() } });
  if (rotated.modifiedCount === 0) {
    await Session.updateMany({ family: session.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
    clearAuthCookies(res);
    throw new AppError(401, ErrorCodes.AUTH_REQUIRED, 'Your session has expired. Please sign in again.');
  }
  return publicUser(user);
}

export async function logout(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (token) await Session.updateOne({ tokenHash: sha256(token) }, { $set: { revokedAt: new Date() } });
  clearAuthCookies(res);
  if (req.user) await audit(req, { action: 'auth.logout', entityType: 'user', entityId: req.user.id });
}

export async function changePassword(req: Request, res: Response, currentPassword: string, newPassword: string) {
  const user = await User.findById(req.user!.id).select('+passwordHash');
  if (!user) throw AppError.notFound('User');
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw AppError.unprocessable(ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Current password is incorrect.', [{ field: 'currentPassword', code: 'INVALID' }]);
  }
  user.passwordHash = await hashPassword(newPassword);
  user.tokenVersion += 1;
  user.mustChangePassword = false;
  await user.save();
  invalidateUserCache(String(user._id));
  await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await issueSession(req, res, user);
  await audit(req, { action: 'auth.change_password', entityType: 'user', entityId: String(user._id) });
}
