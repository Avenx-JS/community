import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

// An IANA zone name this runtime can format in, aliases included
// (America/Argentina/Buenos_Aires as well as America/Buenos_Aires), in its
// proper case: Intl accepts europe/berlin too, which clients must not store.
const ZONE_SHAPE = /^(UTC|[A-Z][A-Za-z_]+(\/[A-Z0-9][A-Za-z0-9_+-]*)+)$/;
export function isTimeZone(value: unknown): boolean {
  if (typeof value !== 'string' || !ZONE_SHAPE.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

@ValidatorConstraint({ name: 'ianaTimeZone', async: false })
class TimeZoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isTimeZone(value);
  }

  defaultMessage(): string {
    return 'timezone must be an IANA time zone name, such as Europe/Berlin';
  }
}

// PUT /users/me/preferences: the whole set, every field required, as PUT
// replaces. GET returns the same shape.
export class UpdateUserPreferencesDto {
  @ApiProperty({
    description:
      'Whether the platform may email you about activity. Stored for the ' +
      'notification emails to come: today the API sends only account emails ' +
      '(password reset, address confirmation), which this never turns off.',
  })
  @IsBoolean()
  email_notifications!: boolean;

  @ApiProperty({
    description:
      'The new_posts notification setting a community you join starts with. ' +
      'Applied when you subscribe; communities you already joined keep ' +
      'their own setting (/communities/{name}/notification-preferences).',
  })
  @IsBoolean()
  new_community_notifications!: boolean;

  @ApiProperty({
    description:
      'Whether posts of nsfw communities appear in your cross-community ' +
      'listings, search and discovery. Posts labelled nsfw are shown either ' +
      'way, flagged for clients to blur.',
  })
  @IsBoolean()
  show_nsfw!: boolean;

  @ApiProperty({ example: 'Europe/Berlin', description: 'IANA time zone.' })
  @IsString()
  @Validate(TimeZoneConstraint)
  timezone!: string;

  @ApiProperty({
    example: 'de',
    description: 'A BCP 47 language tag: language, optional script and region.',
  })
  @IsString()
  @Length(2, 35)
  @Matches(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/, {
    message: 'language must be a language tag such as de, en-GB or zh-Hant-TW',
  })
  language!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Whether notifications reach your registered browsers by Web Push ' +
      '(/users/me/push-subscriptions). Per community, new-post pushes ' +
      'also follow /communities/{name}/notification-preferences. Optional ' +
      'in PUT: absent means the default, true.',
  })
  @IsOptional()
  @IsBoolean()
  push_notifications?: boolean;
}

export type UserPreferences = Required<UpdateUserPreferencesDto>;

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  email_notifications: true,
  new_community_notifications: true,
  show_nsfw: false,
  timezone: 'UTC',
  language: 'en',
  push_notifications: true,
};
