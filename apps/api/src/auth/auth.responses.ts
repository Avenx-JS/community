import { ApiProperty } from '@nestjs/swagger';
import type { AuthResponse } from './auth.service';

export class PasswordForgotResponse {
  @ApiProperty({
    description: 'The same text whether or not the address has an account.',
  })
  message!: string;
}

export class AuthUserResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  username!: string;
}

export class AuthTokensResponse implements AuthResponse {
  @ApiProperty({ description: 'Opaque bearer access token.' })
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({
    description: 'Single-use refresh token; reuse revokes the session.',
  })
  refreshToken!: string;

  @ApiProperty({ format: 'date-time' })
  refreshTokenExpiresAt!: string;

  @ApiProperty({ type: AuthUserResponse })
  user!: AuthUserResponse;
}

export class SessionResponse {
  @ApiProperty({ description: 'Session ID, for DELETE /auth/sessions/{id}.' })
  id!: string;

  @ApiProperty({ format: 'date-time', description: 'When you signed in.' })
  created_at!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'The last token rotation, accurate to the 15-minute access token.',
  })
  last_used_at!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '203.0.113.0/24',
    description:
      'The network last used: an IPv4 /24 or IPv6 /48. The full address is never stored.',
  })
  ip_prefix!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 255 })
  user_agent!: string | null;

  @ApiProperty({ description: 'Whether this request was made with it.' })
  current!: boolean;
}

export class SessionListResponse {
  @ApiProperty({ type: [SessionResponse] })
  items!: SessionResponse[];
}
