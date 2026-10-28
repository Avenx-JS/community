import { Transform } from 'class-transformer';
import { IsString, Length, Validate } from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

export class LiftRestrictionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 2000)
  @Validate(PlainTextConstraint)
  lift_reason!: string;
}
