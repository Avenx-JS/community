import { SetMetadata } from '@nestjs/common';
import type { PlatformRole } from '../users/users.service';

export const REQUIRED_PLATFORM_ROLES = 'requiredPlatformRoles';

export function RequiresRole(...roles: PlatformRole[]) {
  return SetMetadata(REQUIRED_PLATFORM_ROLES, roles);
}
