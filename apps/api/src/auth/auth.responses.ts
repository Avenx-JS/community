import { ApiProperty } from '@nestjs/swagger';
import type { AuthResponse } from './auth.service';

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
