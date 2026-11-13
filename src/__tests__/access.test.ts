import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_CUSTOMER, ROLE_PERMISSIONS } from '../config/permissions';

describe('customer details and customer money are Admin only', () => {
  it('admin has every customer permission', () => {
    for (const p of ADMIN_ONLY_CUSTOMER) expect(ROLE_PERMISSIONS.admin).toContain(p);
  });
  it.each(['manager', 'sales', 'operations', 'accounts'] as const)('%s has none of them, only the name lookup', (role) => {
    for (const p of ADMIN_ONLY_CUSTOMER) expect(ROLE_PERMISSIONS[role]).not.toContain(p);
    expect(ROLE_PERMISSIONS[role]).toContain('companies.lookup');
  });
});
