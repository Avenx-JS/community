import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export function hasControlCharacters(
  value: string,
  allowTextWhitespace: boolean,
): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      (code === 0x7f ||
        (code < 0x20 &&
          !(allowTextWhitespace && [0x09, 0x0a, 0x0d].includes(code))))
    ) {
      return true;
    }
  }
  return false;
}

@ValidatorConstraint({ name: 'plainText', async: false })
export class PlainTextConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && !hasControlCharacters(value, true);
  }

  defaultMessage(): string {
    return 'must not contain control characters';
  }
}

@ValidatorConstraint({ name: 'safeIdentifier', async: false })
export class SafeIdentifierConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && !hasControlCharacters(value, false);
  }

  defaultMessage(): string {
    return 'must not contain control characters';
  }
}
