import { ValidateBy, type ValidationOptions } from 'class-validator';

// Names that are routes, not resources: a static path segment registered
// before a :username or :name route hides the account or community of that
// name at its own URL. Compared case-insensitively, as both unique indexes
// are (the columns' utf8mb4_0900_ai_ci collation). Shared by the DTOs and
// by the availability checks (name-availability.service.ts), so the two can
// never disagree.

// /users/autocomplete. 'me' needs no entry: it is shorter than the
// three-character minimum.
export const RESERVED_USERNAMES: readonly string[] = ['autocomplete'];

// /communities/name-available, /communities/trending and
// /communities/recommended.
export const RESERVED_COMMUNITY_NAMES: readonly string[] = [
  'name-available',
  'recommended',
  'trending',
];

export const RESERVED_USERNAME_CONSTRAINT = 'isNotReservedUsername';
export const RESERVED_COMMUNITY_NAME_CONSTRAINT = 'isNotReservedCommunityName';

const isReserved = (list: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && list.includes(value.toLowerCase());

export const isReservedUsername = (value: unknown): boolean =>
  isReserved(RESERVED_USERNAMES, value);

export const isReservedCommunityName = (value: unknown): boolean =>
  isReserved(RESERVED_COMMUNITY_NAMES, value);

export function IsNotReservedUsername(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: RESERVED_USERNAME_CONSTRAINT,
      validator: {
        validate: (value: unknown) => !isReservedUsername(value),
        defaultMessage: () => 'username is reserved',
      },
    },
    options,
  );
}

export function IsNotReservedCommunityName(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: RESERVED_COMMUNITY_NAME_CONSTRAINT,
      validator: {
        validate: (value: unknown) => !isReservedCommunityName(value),
        defaultMessage: () => 'name is reserved',
      },
    },
    options,
  );
}
