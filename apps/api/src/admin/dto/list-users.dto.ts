import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';
import type { PlatformRole } from '../../users/users.service';

export class ListUsersDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Validate(PlainTextConstraint)
  search?: string;

  @IsOptional()
  @IsIn(['user', 'moderator', 'admin'])
  role?: PlatformRole;

  @IsOptional()
  @IsIn(['active', 'suspended', 'banned'])
  status?: 'active' | 'suspended' | 'banned';

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsIn(['new', 'oldest', 'username'])
  sort: 'new' | 'oldest' | 'username' = 'new';
}
