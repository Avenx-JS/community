import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class PushSubscriptionKeysDto {
  /** The browser's P-256 public key, base64url (65 bytes uncompressed). */
  @IsString()
  @MaxLength(128)
  @Matches(BASE64URL, { message: 'keys.p256dh must be base64url' })
  p256dh!: string;

  /** The 16-byte authentication secret, base64url. */
  @IsString()
  @MaxLength(32)
  @Matches(BASE64URL, { message: 'keys.auth must be base64url' })
  auth!: string;
}

// The browser's PushSubscription.toJSON(), as is.
export class CreatePushSubscriptionDto {
  @ApiProperty({
    description:
      "The push service URL (https, one of the operator's allowed push " +
      'service hosts).',
    example: 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91b',
  })
  @IsString()
  @MaxLength(2048)
  endpoint!: string;

  @ApiProperty({ type: PushSubscriptionKeysDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;

  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    description:
      'Milliseconds since the epoch when the browser expires it; null for none.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expirationTime?: number | null;
}
