import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

export type SafeRouteParamKind = 'id' | 'username' | 'communityName';

@Injectable()
export class SafeRouteParamPipe implements PipeTransform<string, string> {
  constructor(private readonly kind: SafeRouteParamKind = 'id') {}

  transform(value: string): string {
    const valid =
      typeof value === 'string' &&
      (this.kind === 'id'
        ? /^[A-Za-z0-9_-]{1,36}$/.test(value)
        : this.kind === 'username'
          ? /^[A-Za-z0-9_]{3,50}$/.test(value)
          : /^[A-Za-z0-9_-]{1,50}$/.test(value));

    if (!valid) {
      throw new BadRequestException('Invalid route parameter');
    }
    return value;
  }
}
