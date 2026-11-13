import { SetMetadata } from '@nestjs/common';
import type { PlatformRole } from '../users/users.service';

export const REQUIRED_PLATFORM_ROLES = 'requiredPlatformRoles';

// The roles a route accepts, any one of them; AdminGuard defaults to
// ['admin']. An account holds exactly one role (users.role), so this lists
// alternatives, never roles held together: /admin/users/:id/roles sets that
// one role and needs no role table.
export function RequiresRole(...roles: PlatformRole[]) {
  return SetMetadata(REQUIRED_PLATFORM_ROLES, roles);
}
