import { describe, expect, it } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { PositiveIntRouteParamPipe } from './positive-int-route-param.pipe';

describe('PositiveIntRouteParamPipe', () => {
  const pipe = new PositiveIntRouteParamPipe(4294967295);

  it('parses integers within the bound from strings and numbers', () => {
    expect(pipe.transform('1')).toBe(1);
    expect(pipe.transform('4294967295')).toBe(4294967295);
    expect(pipe.transform(7)).toBe(7);
  });

  it.each([
    '0',
    '-1',
    '1.0',
    '1e3',
    ' 1',
    'abc',
    '',
    '4294967296',
    0,
    -1,
    1.5,
    NaN,
    4294967296,
  ])('rejects %p', (value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});
