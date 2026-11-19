import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsOptional } from 'class-validator';
import type {
  NameAvailability,
  UnavailableReason,
} from './name-availability.service';

// Any value is accepted here and judged by the DTO the name is for, so an
// invalid name is { available: false, reason: 'invalid' }, never a 400.
export class UsernameAvailabilityQueryDto {
  @ApiPropertyOptional({
    description:
      'The username to check, by the rules of POST /auth/register: 3-50 ' +
      'letters, digits or underscores, not reserved.',
  })
  @IsOptional()
  @Allow()
  username?: unknown;
}

export class CommunityNameAvailabilityQueryDto {
  @ApiPropertyOptional({
    description:
      'The community name to check, by the rules of POST /communities: ' +
      'trimmed, 1-50 letters, digits, underscores or hyphens, not reserved.',
  })
  @IsOptional()
  @Allow()
  name?: unknown;
}

export class NameAvailabilityResponse implements NameAvailability {
  @ApiProperty()
  available!: boolean;

  @ApiPropertyOptional({
    enum: ['taken', 'invalid', 'reserved'],
    description:
      'Why not, when not available: taken (case-insensitively), invalid ' +
      'by the rules of the create route, or reserved (a route name).',
  })
  reason?: UnavailableReason;
}
