import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Length, Matches, ValidateIf } from 'class-validator';

// Body of POST /admin/reports/:id/assign. The same username rules as
// ManageModeratorDto.
export class AssignReportDto {
  @ApiPropertyOptional({
    description:
      'The administrator to assign the report to. Omit it to assign the ' +
      'report to yourself.',
    minLength: 3,
    maxLength: 50,
    pattern: '^[a-zA-Z0-9_]+$',
  })
  // Absent means the caller; unlike @IsOptional(), an explicit null is
  // refused rather than read as a username.
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username?: string;
}
