import type { Role } from './constants';

/**
 * Role / permission matrix (gap 8 in the manual review).
 * The backend is the single source of truth: /auth/me sends the caller's
 * permission list to the UI, which only uses it to hide controls.
 */
export const PERMISSIONS = [
  'dashboard.view',
  'leads.view',
  'leads.manage',
  'companies.lookup',
  'companies.view',
  'companies.manage',
  'companies.deactivate',
  'quotations.view',
  'quotations.manage',
  'quotations.issue',
  'quotations.decide',
  'customers.finance',
  'vehicles.view',
  'vehicles.manage',
  'vehicles.changeStatus',
  'drivers.view',
  'drivers.manage',
  'documents.view',
  'documents.manage',
  'renewals.view',
  'trips.view',
  'trips.manage',
  'trips.dispatch',
  'trips.deliver',
  'trips.cancel',
  'trips.correct',
  'trips.overrideCompliance',
  'reports.view',
  'reports.export',
  'inventory.view',
  'inventory.manage',
  'purchases.view',
  'purchases.manage',
  'expenses.view',
  'expenses.manage',
  'expenses.approve',
  'payroll.view',
  'payroll.manage',
  'users.manage',
  'settings.manage',
  'audit.view',
  'jobs.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];

/**
 * Customer details and customer money are Admin only (user decision, 2026-11-12):
 * the customer master, quotations (rates, GSTIN, addresses), trip freight,
 * margins and, later, invoices, receipts and outstanding amounts.
 * Other roles get `companies.lookup`, which returns a customer's code and name only.
 */
export const ADMIN_ONLY_CUSTOMER: Permission[] = [
  'companies.view',
  'companies.manage',
  'companies.deactivate',
  'quotations.view',
  'quotations.manage',
  'quotations.issue',
  'quotations.decide',
  'customers.finance',
];
const VIEW_CORE: Permission[] = [
  'dashboard.view',
  'leads.view',
  'companies.lookup',
  'vehicles.view',
  'drivers.view',
  'documents.view',
  'renewals.view',
  'trips.view',
  'reports.view',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL,
  manager: ALL.filter((p) => !['users.manage', 'settings.manage', 'jobs.view', ...ADMIN_ONLY_CUSTOMER].includes(p)),
  sales: [...VIEW_CORE, 'leads.manage', 'reports.export'],
  operations: [
    ...VIEW_CORE,
    'vehicles.manage',
    'drivers.manage',
    'documents.manage',
    'trips.manage',
    'trips.dispatch',
    'trips.deliver',
    'trips.cancel',
    'inventory.view',
    'inventory.manage',
    'purchases.view',
    'purchases.manage',
    'expenses.view',
    'expenses.manage',
  ],
  accounts: [...VIEW_CORE, 'reports.export', 'inventory.view', 'purchases.view', 'purchases.manage', 'expenses.view', 'expenses.manage', 'expenses.approve', 'payroll.view', 'payroll.manage'],
};

export function permissionsFor(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function can(role: Role, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}
