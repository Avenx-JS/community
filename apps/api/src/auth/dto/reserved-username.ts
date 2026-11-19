import { ValidateBy, type ValidationOptions } from 'class-validator';

// Path segments under /users that are routes, not profiles: an account with
// one of these names could never be reached at /users/:username. Compared
// case-insensitively, as users.username is unique. 'me' needs no entry: it
// is shorter than the three-character minimum.
export const RESERVED_USERNAMES: readonly string[] = ['autocomplete'];

export const isReservedUsername = (value: unknown): boolean =>
  typeof value === 'string' && RESERVED_USERNAMES.includes(value.toLowerCase());

export function IsNotReservedUsername(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isNotReservedUsername',
      validator: {
        validate: (value: unknown) => !isReservedUsername(value),
        defaultMessage: () => 'username is reserved',
      },
    },
    options,
  );
}
