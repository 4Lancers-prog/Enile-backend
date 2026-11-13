import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { escapeRegex, normalizeName, normalizeRegistration } from '../../lib/normalize';
import { validate } from '../../middleware/validate';
import { Company } from '../../models/Company';
import { Lead } from '../../models/Lead';
import { Quotation } from '../../models/Quotation';
import { Trip } from '../../models/Trip';
import { Vehicle } from '../../models/Vehicle';
import { companySearchFilter } from '../companies/companies.service';

export const searchRouter = Router();

const query = z.object({ q: z.string().trim().min(2).max(60) });

/** Global header search: one request, indexed prefix lookups, scoped by permission. */
searchRouter.get(
  '/',
  validate({ query }),
  asyncHandler(async (req, res) => {
    const { q } = req.query as unknown as z.infer<typeof query>;
    const perms = req.user!.permissions;
    const upper = q.toUpperCase();
    const none = Promise.resolve([] as unknown[]);
    const [companies, vehicles, trips, quotations, leads] = await Promise.all([
      perms.includes('companies.view') ? Company.find(companySearchFilter(q)).select('companyCode legalName status').limit(5).lean() : none,
      perms.includes('vehicles.view')
        ? Vehicle.find({ normalizedRegistration: new RegExp('^' + escapeRegex(normalizeRegistration(q))) }).select('registrationNumber status').limit(5).lean()
        : none,
      perms.includes('trips.view') ? Trip.find({ tripNumber: new RegExp('^' + escapeRegex(upper)) }).select('tripNumber status').limit(5).lean() : none,
      perms.includes('quotations.view')
        ? Quotation.find({ quotationNumber: new RegExp('^' + escapeRegex(upper)) }).select('quotationNumber status totalPaise').limit(5).lean()
        : none,
      perms.includes('leads.view') ? Lead.find({ normalizedName: new RegExp('^' + escapeRegex(normalizeName(q))) }).select('name status').limit(5).lean() : none,
    ]);
    res.json({ companies, vehicles, trips, quotations, leads });
  }),
);
