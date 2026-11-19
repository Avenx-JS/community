import { Inject, Injectable } from '@nestjs/common';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { RegisterDto } from '../auth/dto/register.dto';
import { CreateCommunityDto } from '../communities/dto/create-community.dto';
import {
  RESERVED_COMMUNITY_NAME_CONSTRAINT,
  RESERVED_USERNAME_CONSTRAINT,
} from './reserved-names';

export type UnavailableReason = 'taken' | 'invalid' | 'reserved';

export interface NameAvailability {
  available: boolean;
  // Absent when available.
  reason?: UnavailableReason;
}

// Case-insensitive, as the unique indexes compare under the columns'
// utf8mb4_0900_ai_ci collation: "Alice" is taken once "alice" exists.
// A deleted account's username is released: account deletion renames the
// row to deleted_<id> (AccountDeletionService), so the old name is free at
// once. A deleted or suspended community keeps its row and its name: it
// stays taken. Values: the name.
export const USERNAME_TAKEN_SQL =
  'SELECT 1 AS taken FROM users WHERE username = ? LIMIT 1';
export const COMMUNITY_NAME_TAKEN_SQL =
  'SELECT 1 AS taken FROM communities WHERE name = ? LIMIT 1';

// The one rule set: the DTO's own decorators on that one property, its
// transforms included (a community name is trimmed). The other required
// properties of the DTO are absent and skipped. A reserved name is told
// apart from an otherwise invalid one by its constraint.
async function check(
  dto: ClassConstructor<object>,
  property: string,
  value: unknown,
  reservedConstraint: string,
): Promise<{ value: string } | NameAvailability> {
  if (typeof value !== 'string') {
    return { available: false, reason: 'invalid' };
  }
  const instance = plainToInstance(dto, { [property]: value });
  const errors = (
    await validate(instance, { skipMissingProperties: true })
  ).filter((error) => error.property === property);
  if (errors.length === 0) {
    return { value: (instance as Record<string, string>)[property] };
  }
  const constraints = Object.keys(errors[0].constraints ?? {});
  return {
    available: false,
    reason:
      constraints.length === 1 && constraints[0] === reservedConstraint
        ? 'reserved'
        : 'invalid',
  };
}

// GET /auth/username-available and GET /communities/name-available: one
// response shape whatever the input, never a 400, so a form can ask while
// the user types. Each is an enumeration oracle, as registering and creating
// are; their own rate limits (AuthRateLimitService) throttle it.
@Injectable()
export class NameAvailabilityService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  username(value: unknown): Promise<NameAvailability> {
    return this.lookup(
      RegisterDto,
      'username',
      value,
      RESERVED_USERNAME_CONSTRAINT,
      USERNAME_TAKEN_SQL,
    );
  }

  communityName(value: unknown): Promise<NameAvailability> {
    return this.lookup(
      CreateCommunityDto,
      'name',
      value,
      RESERVED_COMMUNITY_NAME_CONSTRAINT,
      COMMUNITY_NAME_TAKEN_SQL,
    );
  }

  private async lookup(
    dto: ClassConstructor<object>,
    property: string,
    value: unknown,
    reservedConstraint: string,
    takenSql: string,
  ): Promise<NameAvailability> {
    const checked = await check(dto, property, value, reservedConstraint);
    if (!('value' in checked)) {
      return checked;
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(takenSql, [
      checked.value,
    ]);
    return rows.length > 0
      ? { available: false, reason: 'taken' }
      : { available: true };
  }
}
