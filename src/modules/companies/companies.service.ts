import type { Request } from 'express';
import { Types } from 'mongoose';
import { AppError, ErrorCodes } from '../../lib/errors';
import { isValidGstin, normalizeGstin, stateCodeFromGstin, INDIAN_STATE_CODES } from '../../lib/gstin';
import { escapeRegex, normalizeName, normalizePhone } from '../../lib/normalize';
import { Company, type ICompany } from '../../models/Company';
import { nextSequence } from '../../models/Counter';
import { audit } from '../../services/audit.service';
import type { CreateCompanyInput } from './companies.schema';

export interface DuplicateMatch {
  id: string;
  companyCode: string;
  legalName: string;
  gstin?: string | null;
  status: string;
  matchedOn: ('gstin' | 'name' | 'phone')[];
}

type CompanyInput = Partial<Omit<CreateCompanyInput, 'confirmDuplicate' | 'gstin'>> & { gstin?: string | null };

/** Normalizes searchable keys and derives state code / PAN from the GSTIN. */
export function buildCompanyFields(input: CompanyInput) {
  const out: Partial<ICompany> = {};
  if (input.legalName !== undefined) {
    out.legalName = input.legalName;
    out.normalizedName = normalizeName(input.legalName);
  }
  if (input.tradeName !== undefined) out.tradeName = input.tradeName;
  if (input.customerType !== undefined) out.customerType = input.customerType;
  if (input.creditDays !== undefined) out.creditDays = input.creditDays;
  if (input.notes !== undefined) out.notes = input.notes;
  if (input.gstin !== undefined) {
    if (input.gstin === null || input.gstin === '') {
      out.gstin = null;
      out.pan = undefined;
    } else {
      const g = normalizeGstin(input.gstin);
      if (!isValidGstin(g)) {
        throw AppError.unprocessable(ErrorCodes.GSTIN_FORMAT_INVALID, 'GSTIN does not pass format/check rules. Please recheck the entry.', [
          { field: 'gstin', code: 'GSTIN_FORMAT_INVALID' },
        ]);
      }
      out.gstin = g;
      out.pan = g.slice(2, 12);
    }
  }
  if (input.billingAddress !== undefined) {
    const addr = { ...input.billingAddress };
    const fromGst = out.gstin ? stateCodeFromGstin(out.gstin) : undefined;
    if (fromGst) {
      addr.stateCode = fromGst;
      addr.state = addr.state || INDIAN_STATE_CODES[fromGst];
    }
    out.billingAddress = addr;
  }
  if (input.contacts !== undefined) {
    out.contacts = input.contacts.map((c, i) => ({
      ...c,
      normalizedPhone: c.phone ? normalizePhone(c.phone) : undefined,
      isPrimary: c.isPrimary ?? i === 0,
    }));
    out.phones = [...new Set(out.contacts.map((c) => c.normalizedPhone).filter((p): p is string => Boolean(p)))];
  }
  return out;
}

/** Possible duplicates by GSTIN, normalized name or phone (manual 4.2: warn, never auto-merge). */
export async function findDuplicates(params: { gstin?: string | null; normalizedName?: string; phones?: string[]; excludeId?: string }): Promise<DuplicateMatch[]> {
  const or: Record<string, unknown>[] = [];
  if (params.gstin) or.push({ gstin: params.gstin });
  if (params.normalizedName) or.push({ normalizedName: params.normalizedName });
  if (params.phones?.length) or.push({ phones: { $in: params.phones } });
  if (!or.length) return [];
  const filter: Record<string, unknown> = { $or: or };
  if (params.excludeId && Types.ObjectId.isValid(params.excludeId)) filter._id = { $ne: new Types.ObjectId(params.excludeId) };
  const rows = await Company.find(filter).select('companyCode legalName gstin status normalizedName phones').limit(5).lean();
  return rows.map((r) => ({
    id: String(r._id),
    companyCode: r.companyCode,
    legalName: r.legalName,
    gstin: r.gstin,
    status: r.status,
    matchedOn: [
      ...(params.gstin && r.gstin === params.gstin ? (['gstin'] as const) : []),
      ...(params.normalizedName && r.normalizedName === params.normalizedName ? (['name'] as const) : []),
      ...(params.phones?.some((p) => r.phones?.includes(p)) ? (['phone'] as const) : []),
    ],
  }));
}

export async function createCompany(req: Request, input: CreateCompanyInput, leadId?: string) {
  const { confirmDuplicate, ...rest } = input;
  const fields = buildCompanyFields(rest);
  const dups = await findDuplicates({ gstin: fields.gstin, normalizedName: fields.normalizedName, phones: fields.phones });
  const gstHit = dups.find((d) => d.matchedOn.includes('gstin'));
  if (gstHit) {
    throw AppError.conflict(ErrorCodes.COMPANY_DUPLICATE, 'A company with this GSTIN already exists.', { matches: [gstHit] }, [{ field: 'gstin', code: 'DUPLICATE' }]);
  }
  if (dups.length && !confirmDuplicate) {
    throw AppError.conflict(ErrorCodes.COMPANY_DUPLICATE, 'Possible duplicate company found. Review the matches and confirm to continue.', { matches: dups });
  }
  const seq = await nextSequence('company');
  const company = await Company.create({
    ...fields,
    companyCode: `CMP-${String(seq).padStart(5, '0')}`,
    leadId: leadId ?? null,
    createdBy: req.user!.id,
  });
  await audit(req, { action: 'company.create', entityType: 'company', entityId: String(company._id), meta: { companyCode: company.companyCode, confirmedDuplicate: Boolean(confirmDuplicate && dups.length) } });
  return company;
}

/** Builds an index-friendly filter from a free-text search. */
export function companySearchFilter(q?: string): Record<string, unknown> {
  if (!q) return {};
  const upper = q.toUpperCase().replace(/\s/g, '');
  if (/^\d{2}[A-Z]{5}\d{4}/.test(upper)) return { gstin: new RegExp('^' + escapeRegex(upper)) };
  if (/^CMP-/.test(upper)) return { companyCode: new RegExp('^' + escapeRegex(upper)) };
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 6 && digits.length === q.replace(/[\s+-]/g, '').length) return { phones: normalizePhone(digits) };
  return { normalizedName: new RegExp('^' + escapeRegex(normalizeName(q))) };
}
