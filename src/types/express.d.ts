import type { Role } from '../config/constants';
import type { Permission } from '../config/permissions';

declare global {
  namespace Express {
    interface AuthUser {
      id: string;
      name: string;
      email: string;
      role: Role;
      permissions: Permission[];
    }
    interface Request {
      id: string;
      user?: AuthUser;
    }
  }
}

export {};
