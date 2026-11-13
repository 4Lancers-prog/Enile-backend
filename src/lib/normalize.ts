/** Normalization helpers (manual 3.2): search keys are normalized, display values preserved. */

export const collapseSpaces = (v: string) => v.trim().replace(/\s+/g, ' ');

export const normalizeName = (v: string) =>
  collapseSpaces(v)
    .toLowerCase()
    .replace(/[.,'"`]/g, '')
    .replace(/\b(pvt|private|ltd|limited|llp|co|company|inc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export const normalizeEmail = (v: string) => v.trim().toLowerCase();

/** Keeps the last 10 digits for Indian numbers so +91/0 prefixes match. */
export const normalizePhone = (v: string) => {
  const digits = v.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

/** "MH 12-ab 1234" -> "MH12AB1234" */
export const normalizeRegistration = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const normalizeLicence = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Escape user text before using it in a RegExp (prevents ReDoS / regex injection). */
export const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Anchored prefix regex: can use an index on the normalized field. */
export const prefixRegex = (v: string) => new RegExp('^' + escapeRegex(v));
