import type { RequestHandler } from 'express';
import { permissionsFor, type Permission } from '../config/permissions';
import { AppError, ErrorCodes } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';
import { User } from '../models/User';

export const ACCESS_COOKIE = 'enile_at';
export const REFRESH_COOKIE = 'enile_rt';
export const CSRF_COOKIE = 'enile_csrf';

/**
 * Short in-process cache of user status so a disabled account or changed role
 * takes effect within seconds without a DB read on every request.
 */
const USER_CACHE_MS = 15_000;
const userCache = new Map<string, { at: number; status: string; tokenVersion: number; name: string; email: string; role: string }>();

export function invalidateUserCache(userId: string) {
  userCache.delete(userId);
}

async function loadUser(id: string) {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit;
  const u = await User.findById(id).select('name email role status tokenVersion').lean();
  if (!u) return null;
  const entry = { at: Date.now(), status: u.status, tokenVersion: u.tokenVersion, name: u.name, email: u.email, role: u.role };
  if (userCache.size > 5000) userCache.clear();
  userCache.set(id, entry);
  return entry;
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
    if (!token) throw new AppError(401, ErrorCodes.AUTH_REQUIRED, 'Please sign in to continue.');
    let claims;
    try {
      claims = verifyAccessToken(token);
    } catch {
      throw new AppError(401, ErrorCodes.AUTH_REQUIRED, 'Your session has expired. Please sign in again.');
    }
    const u = await loadUser(claims.sub);
    if (!u || u.tokenVersion !== claims.tv) throw new AppError(401, ErrorCodes.AUTH_REQUIRED, 'Your session has expired. Please sign in again.');
    if (u.status !== 'active') throw new AppError(403, ErrorCodes.AUTH_ACCOUNT_DISABLED, 'This account is disabled. Contact the administrator.');
    const role = u.role as typeof claims.role;
    req.user = { id: claims.sub, name: u.name, email: u.email, role, permissions: permissionsFor(role) };
    next();
  } catch (err) {
    next(err);
  }
};

/** Enforced on every endpoint (manual 4.1), not just by hiding UI controls. */
export const authorize =
  (...required: Permission[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(new AppError(401, ErrorCodes.AUTH_REQUIRED, 'Please sign in to continue.'));
    const ok = required.every((p) => req.user!.permissions.includes(p));
    return ok ? next() : next(AppError.forbidden());
  };
