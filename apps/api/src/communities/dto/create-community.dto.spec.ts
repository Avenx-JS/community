import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateCommunityDto } from './create-community.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const transform = (body: unknown): Promise<unknown> =>
  pipe.transform(body, { type: 'body', metatype: CreateCommunityDto });

describe('CreateCommunityDto', () => {
  it('accepts a name with an optional description', async () => {
    await expect(
      transform({ name: ' gardening ', description: 'Plants' }),
    ).resolves.toEqual({ name: 'gardening', description: 'Plants' });
  });

  // Rules are published only through PUT /communities/:name/rules.
  it.each([{ rules: 'Be kind' }, { rules: '' }, { rules: null }])(
    'rejects a legacy rules property: %o',
    async (extra) => {
      const error = await transform({ name: 'gardening', ...extra }).catch(
        (rejection: unknown) => rejection,
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: ['property rules should not exist'],
      });
    },
  );
});
