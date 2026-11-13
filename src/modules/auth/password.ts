import argon2 from 'argon2';

/** Argon2id with OWASP-recommended minimums (manual 7). */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string) => argon2.hash(plain, OPTIONS);

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** Pre-computed hash used to equalize timing when the email does not exist. */
let dummyHash: string | null = null;
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= await hashPassword('not-a-real-password-0');
  await verifyPassword(dummyHash, plain);
}
