import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AllowRestricted } from '../auth/allow-restricted.decorator';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import {
  DataExportService,
  type DataExportDto,
  type DataExportStatus,
} from './data-export.service';
import {
  UpdateUserPreferencesDto,
  type UserPreferences,
} from './dto/user-preferences.dto';
import { UserPreferencesService } from './user-preferences.service';

class DataExportResponse implements DataExportDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    enum: ['pending', 'ready', 'failed', 'downloaded', 'expired'],
  })
  status!: DataExportStatus;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When a ready export stops being downloadable.',
  })
  expires_at!: string | null;
}

// The account's own settings and data, beside /users/me.
@ApiTags('users')
@Controller('users/me')
export class AccountDataController {
  constructor(
    private readonly preferences: UserPreferencesService,
    private readonly exports: DataExportService,
    private readonly rateLimit: AuthRateLimitService,
  ) {}

  @Get('preferences')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get your preferences',
    description: 'Global defaults; an account that never set them has these.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: UpdateUserPreferencesDto })
  getPreferences(
    @Req() request: AuthenticatedRequest,
  ): Promise<UserPreferences> {
    return this.preferences.get(request.user.id);
  }

  @Put('preferences')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Replace your preferences',
    description:
      'Every field is required: PUT replaces the whole set. Returns the ' +
      'stored preferences.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: UpdateUserPreferencesDto })
  @ApiErrorResponses({
    400: 'A missing, invalid or unknown field.',
  })
  putPreferences(
    @Body() body: UpdateUserPreferencesDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<UserPreferences> {
    return this.preferences.replace(request.user.id, body);
  }

  @Post('export')
  @UseGuards(AuthGuard)
  @AllowRestricted()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request an export of your data',
    description:
      'Starts building a JSON file of everything your account wrote, chose ' +
      'or was shown, and answers at once with its id. Poll ' +
      'GET /users/me/export/{id}: it downloads once, then is gone, and ' +
      'expires after DATA_EXPORT_TTL_HOURS. One export at a time. Also ' +
      'available to suspended and banned accounts: access to one’s data ' +
      'does not depend on standing. Rate limited per client IP and account.',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiAcceptedResponse({ type: DataExportResponse })
  @ApiErrorResponses({ 409: 'An export is already being prepared.' })
  async requestExport(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DataExportDto> {
    const retryAfter = await this.rateLimit.enforceDataExport(
      request.ip ?? request.socket.remoteAddress ?? 'unknown',
      request.user.id,
    );
    if (retryAfter !== null) {
      response.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        'Too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.exports.request(request.user.id);
  }

  @Get('export/:id')
  @UseGuards(AuthGuard)
  @AllowRestricted()
  @ApiOperation({
    summary: 'Download your data export',
    description:
      'While it is being prepared: 202 with its state. When ready: the JSON ' +
      'file, as an attachment, exactly once. Afterwards, or once expired, ' +
      '410. A failed export is 409; request a new one.',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiRouteParam('id', 'id', 'Export ID.')
  @ApiProduces('application/json')
  @ApiOkResponse({
    schema: {
      type: 'object',
      additionalProperties: true,
      description: 'The export: format, generated_at, and one key per section.',
    },
    description:
      'The export file, once. While it is still being prepared the status ' +
      'is 202 instead, with the DataExportResponse body.',
  })
  @ApiErrorResponses({
    400: 'Invalid export ID.',
    404: 'Export not found, or not yours.',
    409: 'The export failed.',
  })
  async downloadExport(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exports.download(request.user.id, id);
    if (result.kind === 'status') {
      response.status(HttpStatus.ACCEPTED).json(result.export);
      return;
    }
    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="community-export-${id}.json"`,
    );
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Length', String(result.body.length));
    response.end(result.body);
  }
}
