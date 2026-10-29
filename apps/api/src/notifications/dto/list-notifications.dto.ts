import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  NOTIFICATION_TYPES,
  type NotificationType,
} from '../notification-metadata';

export class ListNotificationsDto {
  /** false: unread only; true: read only; omitted: both. */
  @ApiPropertyOptional({ type: 'boolean' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  read?: boolean;

  @ApiPropertyOptional({ enum: NOTIFICATION_TYPES })
  @IsOptional()
  @IsIn(NOTIFICATION_TYPES)
  type?: NotificationType;

  @IsOptional()
  @IsString()
  @Length(1, 36)
  @Matches(/^[A-Za-z0-9_-]+$/)
  community_id?: string;

  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;

  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['new', 'oldest'])
  sort: 'new' | 'oldest' = 'new';
}
