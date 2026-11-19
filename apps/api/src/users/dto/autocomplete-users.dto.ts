import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length, Validate } from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

// Query of GET /users/autocomplete. At least two characters: one would page
// through the whole directory ten accounts at a time.
export class AutocompleteUsersDto {
  @ApiProperty({
    minLength: 2,
    maxLength: 50,
    description:
      'Prefix of a username or display name, case-insensitive; a leading @ ' +
      'is ignored.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/^@/, '') : value,
  )
  @IsString()
  @Length(2, 50)
  @Validate(PlainTextConstraint)
  q!: string;
}
