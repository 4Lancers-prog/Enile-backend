import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { AppError, ErrorCodes } from '../../lib/errors';
import { storage } from '../../lib/storage';
import { verifyFileLink, type FileLinkClaims } from '../../lib/tokens';

export const filesRouter = Router();

/**
 * Streams a private file for a valid, unexpired link that was issued to the
 * currently signed-in user. Served as an attachment with nosniff.
 */
filesRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    let claims: FileLinkClaims;
    try {
      claims = verifyFileLink(req.params.token);
    } catch {
      throw new AppError(410, ErrorCodes.FILE_LINK_EXPIRED, 'This download link has expired. Open the document again to get a new link.');
    }
    if (claims.u !== req.user!.id) throw AppError.forbidden();
    const stream = await storage.stream(claims.k);
    res.setHeader('Content-Type', claims.m);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(claims.n)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', (err) => res.destroy(err));
    stream.pipe(res);
  }),
);
