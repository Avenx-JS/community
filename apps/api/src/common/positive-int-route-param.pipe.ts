import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

// Accepts an integer from 1 to `max`. The global ValidationPipe may already
// have converted a `number` parameter, so both forms are handled; a string
// must be plain decimal digits, so "1.5", "1e3" and "-1" are rejected.
@Injectable()
export class PositiveIntRouteParamPipe implements PipeTransform<
  string | number,
  number
> {
  constructor(private readonly max: number) {}

  transform(value: string | number): number {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^[0-9]{1,16}$/.test(value)
          ? Number(value)
          : NaN;

    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > this.max) {
      throw new BadRequestException('Invalid route parameter');
    }
    return parsed;
  }
}
