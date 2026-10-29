import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

export type SafeRouteParamKind = 'id' | 'username' | 'communityName';

// Also published as the path parameter patterns in the OpenAPI document.
export const SAFE_ROUTE_PARAM_PATTERNS: Record<SafeRouteParamKind, RegExp> = {
  id: /^[A-Za-z0-9_-]{1,36}$/,
  username: /^[A-Za-z0-9_]{3,50}$/,
  communityName: /^[A-Za-z0-9_-]{1,50}$/,
};

@Injectable()
export class SafeRouteParamPipe implements PipeTransform<string, string> {
  constructor(private readonly kind: SafeRouteParamKind = 'id') {}

  transform(value: string): string {
    const valid =
      typeof value === 'string' &&
      SAFE_ROUTE_PARAM_PATTERNS[this.kind].test(value);

    if (!valid) {
      throw new BadRequestException('Invalid route parameter');
    }
    return value;
  }
}
