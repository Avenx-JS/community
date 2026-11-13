import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// GET /notifications/stream: only the optional ticket.
export class StreamQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'ticket must be base64url' })
  ticket?: string;
}
