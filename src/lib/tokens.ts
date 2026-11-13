import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import type { Role } from '../config/constants';

export interface AccessClaims {
  sub: string;
  role: Role;
  tv: number; // token version: bumped on disable / role change / password change
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`,
    issuer: 'enile-crm',
    audience: 'enile-crm-web',
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
    issuer: 'enile-crm',
    audience: 'enile-crm-web',
  }) as AccessClaims;
}

export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Short-lived, user-bound file download links (manual 7: no public URLs). */
export interface FileLinkClaims {
  k: string; // storage key
  u: string; // user id the link was issued to
  n: string; // download file name
  m: string; // mime type
}

export function signFileLink(claims: FileLinkClaims, ttlSeconds = 300): string {
  return jwt.sign(claims, env.FILE_URL_SECRET, { algorithm: 'HS256', expiresIn: ttlSeconds });
}

export function verifyFileLink(token: string): FileLinkClaims {
  return jwt.verify(token, env.FILE_URL_SECRET, { algorithms: ['HS256'] }) as FileLinkClaims;
}
