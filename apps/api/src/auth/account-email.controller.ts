import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiAuthenticated, ApiErrorResponses } from '../common/openapi';
import { AllowRestricted } from './allow-restricted.decorator';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { ChangeEmailDto, VerifyEmailDto } from './dto/account-email.dto';
import {
  EMAIL_CHANGE_REQUESTED_MESSAGE,
  EmailVerificationService,
  type EmailVerificationResult,
} from './email-verification.service';

export const VERIFICATION_REQUESTED_MESSAGE =
  'A confirmation code has been sent to your email address.';

class AccountEmailMessageResponse {
  @ApiProperty()
  message!: string;
}

class EmailVerificationResponse {
  @ApiProperty({
    enum: ['verified', 'email_changed'],
    description:
      'verified: the current address is confirmed. email_changed: a pending ' +
      'change was applied, and the new address is confirmed.',
  })
  status!: EmailVerificationResult['status'];

  @ApiProperty({ description: 'The confirmed address.' })
  email!: string;
}

// Email verification and change (migration 037). The confirmation route
// takes either code, so a client needs one form for both emails.
@ApiTags('auth')
@Controller()
export class AccountEmailController {
  constructor(
    private readonly verification: EmailVerificationService,
    private readonly rateLimit: AuthRateLimitService,
  ) {}

  @Post('auth/email/verify-request')
  @UseGuards(AuthGuard)
  @AllowRestricted()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request an email confirmation code',
    description:
      'Sends a new single-use code to your current address; earlier codes ' +
      'stop working. Also available to suspended and banned accounts. Rate ' +
      'limited per client IP and account.',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiAcceptedResponse({ type: AccountEmailMessageResponse })
  @ApiErrorResponses({ 409: 'Your address is already confirmed.' })
  async requestVerification(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccountEmailMessageResponse> {
    await this.enforce(
      response,
      this.rateLimit.enforceEmailVerifyRequest(
        clientIp(request),
        request.user.id,
      ),
    );
    await this.verification.requestVerification(request.user.id);
    return { message: VERIFICATION_REQUESTED_MESSAGE };
  }

  @Post('auth/email/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm an email address with a code',
    description:
      'Takes the code from either email: it confirms your current address, ' +
      'or applies a pending address change. No bearer token: the code is the ' +
      'proof, so it works from the device that reads the email. Codes are ' +
      'single use and expire. Rate limited per client IP and code.',
  })
  @ApiOkResponse({ type: EmailVerificationResponse })
  @ApiErrorResponses({
    400:
      'Invalid input, or an unknown, used, expired or superseded code; all ' +
      'return the same message.',
    409: 'Another account took the new address before the change was confirmed.',
  })
  async verify(
    @Body() body: VerifyEmailDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EmailVerificationResult> {
    await this.enforce(
      response,
      this.rateLimit.enforceEmailVerify(clientIp(request), body.token),
    );
    return this.verification.verify(body.token);
  }

  @Patch('users/me/email')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Change your email address',
    description:
      'Needs your current password. Sends a confirmation code to the new ' +
      'address and a notice to the current one; **the address changes only ' +
      'when the code is confirmed** with POST /auth/email/verify. The answer ' +
      'is the same whether or not the new address is free, so it cannot ' +
      'test which addresses are registered. A new request replaces a pending ' +
      'one. Rate limited per client IP and account.',
  })
  @ApiAuthenticated({ unauthorized: 'Incorrect current password.' })
  @ApiAcceptedResponse({ type: AccountEmailMessageResponse })
  @ApiErrorResponses({
    400: 'Invalid input, or the new address is your current one.',
  })
  async changeEmail(
    @Body() body: ChangeEmailDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccountEmailMessageResponse> {
    await this.enforce(
      response,
      this.rateLimit.enforceEmailChange(clientIp(request), request.user.id),
    );
    await this.verification.requestEmailChange(
      request.user.id,
      body.current_password,
      body.new_email,
    );
    return { message: EMAIL_CHANGE_REQUESTED_MESSAGE };
  }

  private async enforce(
    response: Response,
    check: Promise<number | null>,
  ): Promise<void> {
    const retryAfter = await check;
    if (retryAfter !== null) {
      response.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        'Too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}
