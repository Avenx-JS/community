import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ADMIN_ACTIONS, ADMIN_ACTION_TARGETS } from '../audit-log.service';
import type { AdminAction, AdminActionTarget } from '../audit-log.service';

// target_id alone could not use idx_admin_actions_target, and ids are not
// unique across target kinds.
@ValidatorConstraint({ name: 'targetIdRequiresTargetType', async: false })
export class TargetIdRequiresTargetTypeConstraint implements ValidatorConstraintInterface {
  validate(_targetId: unknown, args: ValidationArguments): boolean {
    return (args.object as ListAdminActionsDto).target_type !== undefined;
  }

  defaultMessage(): string {
    return 'target_id requires target_type';
  }
}

export class ListAdminActionsDto {
  @IsOptional()
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_]+$/)
  actor_username?: string;

  @IsOptional()
  @IsIn(ADMIN_ACTIONS)
  action?: AdminAction;

  @IsOptional()
  @IsIn(ADMIN_ACTION_TARGETS)
  target_type?: AdminActionTarget;

  @IsOptional()
  @IsString()
  @Length(1, 36)
  @Matches(/^[A-Za-z0-9_-]+$/)
  @Validate(TargetIdRequiresTargetTypeConstraint)
  target_id?: string;

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
  @IsIn(['new', 'oldest'])
  sort: 'new' | 'oldest' = 'new';
}
