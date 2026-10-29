import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  SAFE_ROUTE_PARAM_PATTERNS,
  type SafeRouteParamKind,
} from './safe-route-param.pipe';

// Body of every HttpException response; validation failures list each
// violated constraint in `message`.
export class ErrorResponse {
  @ApiProperty({ type: 'integer', example: 404 })
  statusCode!: number;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'Community not found',
  })
  message!: string | string[];

  @ApiProperty({ example: 'Not Found' })
  error!: string;
}

// 403 body for a suspended or banned account; it deliberately carries no
// reason or moderator identity.
export class RestrictedAccountResponse {
  @ApiProperty({ enum: ['suspension', 'ban'] })
  type!: 'suspension' | 'ban';

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'End of a temporary suspension; absent for bans.',
  })
  expires_at?: string;
}

const restrictedDescription = 'The account is suspended or banned.';

interface AuthenticatedOptions {
  // Additional reasons this route answers 403, besides a restricted account.
  forbidden?: string;
  // Routes marked @AllowRestricted() never answer 403 for a restriction.
  allowRestricted?: boolean;
}

export function ApiAuthenticated(options: AuthenticatedOptions = {}) {
  const decorators = [
    ApiBearerAuth(),
    ApiUnauthorizedResponse({
      type: ErrorResponse,
      description: 'Missing, invalid, or expired bearer token.',
    }),
  ];

  if (options.allowRestricted) {
    if (options.forbidden) {
      decorators.push(
        ApiForbiddenResponse({
          type: ErrorResponse,
          description: options.forbidden,
        }),
      );
    }
  } else {
    decorators.push(
      ApiExtraModels(RestrictedAccountResponse, ErrorResponse),
      ApiForbiddenResponse({
        description: [restrictedDescription, options.forbidden]
          .filter(Boolean)
          .join(' '),
        schema: {
          oneOf: [
            { $ref: getSchemaPath(RestrictedAccountResponse) },
            { $ref: getSchemaPath(ErrorResponse) },
          ],
        },
      }),
    );
  }

  return applyDecorators(...decorators);
}

const errorDecorators = {
  400: ApiBadRequestResponse,
  404: ApiNotFoundResponse,
  409: ApiConflictResponse,
  413: ApiPayloadTooLargeResponse,
} as const;

export function ApiErrorResponses(
  responses: Partial<Record<keyof typeof errorDecorators, string>>,
) {
  return applyDecorators(
    ...Object.entries(responses).map(([status, description]) =>
      errorDecorators[Number(status) as keyof typeof errorDecorators]({
        type: ErrorResponse,
        description,
      }),
    ),
  );
}

export function ApiRouteParam(
  name: string,
  kind: SafeRouteParamKind,
  description: string,
) {
  return ApiParam({
    name,
    description,
    schema: { type: 'string', pattern: SAFE_ROUTE_PARAM_PATTERNS[kind].source },
  });
}

// Schema for an object with one integer count per key, e.g. per report status.
export function countsByKey(keys: readonly string[]) {
  return {
    type: 'object' as const,
    properties: Object.fromEntries(
      keys.map((key) => [key, { type: 'integer' as const }]),
    ),
    required: [...keys],
  };
}
