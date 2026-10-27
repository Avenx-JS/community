import { SetMetadata } from '@nestjs/common';

export const ALLOW_RESTRICTED = 'allowRestricted';

export const AllowRestricted = () => SetMetadata(ALLOW_RESTRICTED, true);
