import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { RemoveContentDto } from './remove-content.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (body: object) =>
  pipe.transform(body, { type: 'body', metatype: RemoveContentDto });

describe('RemoveContentDto', () => {
  it('accepts no body and no reason: the reason is optional by decision', async () => {
    await expect(validate({})).resolves.toEqual({});
  });

  it('trims the reason and accepts the 2,000-character bound', async () => {
    await expect(validate({ reason: '  Spam  ' })).resolves.toEqual({
      reason: 'Spam',
    });
    await expect(validate({ reason: 'x'.repeat(2000) })).resolves.toBeDefined();
  });

  it.each([
    [{ reason: 'x'.repeat(2001) }, 'over-long'],
    [{ reason: 'bad\u0000reason' }, 'a control character'],
    [{ reason: '   ' }, 'blank'],
    [{ reason: null }, 'null'],
    [{ reason: 3 }, 'a number'],
    [{ reason: 'Spam', notify: false }, 'an unknown property'],
    [{ removed_by: 'someone-else' }, 'removed_by'],
  ] as [object, string][])('rejects %o (%s)', async (body) => {
    await expect(validate(body)).rejects.toThrow();
  });
});
