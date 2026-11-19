import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  Validate,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';
import { MODMAIL_STATUSES, type ModmailStatus } from '../modmail.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const MODMAIL_BODY_MAX = 10000;
export const MODMAIL_SUBJECT_MAX = 200;

// A message: plain text (line breaks allowed), trimmed, 1-10,000 characters.
export class ModmailMessageBodyDto {
  @ApiProperty({ minLength: 1, maxLength: MODMAIL_BODY_MAX })
  @Transform(trim)
  @IsString()
  @Length(1, MODMAIL_BODY_MAX)
  @Validate(PlainTextConstraint)
  body!: string;
}

// Body of POST /communities/:name/modmail. Without username the caller
// writes to the team; with one, a moderator writes to that account.
export class StartModmailDto extends ModmailMessageBodyDto {
  @ApiProperty({ minLength: 1, maxLength: MODMAIL_SUBJECT_MAX })
  @Transform(trim)
  @IsString()
  @Length(1, MODMAIL_SUBJECT_MAX)
  @Validate(PlainTextConstraint)
  subject!: string;

  @ApiPropertyOptional({
    pattern: '^[a-zA-Z0-9_]{3,50}$',
    description:
      'Moderators only: the account the team writes to. Absent, the caller ' +
      'writes to the moderators.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/)
  username?: string;
}

export class ListModmailDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class ListCommunityModmailDto extends ListModmailDto {
  @ApiPropertyOptional({ enum: MODMAIL_STATUSES, default: 'open' })
  @IsOptional()
  @IsIn(MODMAIL_STATUSES)
  status: ModmailStatus = 'open';
}
