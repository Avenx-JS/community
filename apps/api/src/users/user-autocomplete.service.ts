import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { escapeLikeSearch } from '../common/like-search';
import { loadMediaByIds } from '../media/media-dto';
import { eitherBlockedSql } from './user-block-policy.service';

export const AUTOCOMPLETE_LIMIT = 10;

export interface UserSuggestion {
  username: string;
  display_name: string | null;
  // The avatar's URL; null without one.
  avatar_url: string | null;
}

export interface UserSuggestionList {
  items: UserSuggestion[];
}

// Usernames, then display names, starting with the prefix (case-insensitive,
// as the column collation is). Never deleted accounts, the caller, or an
// account blocked by or blocking the caller: a mention of them would notify
// nobody. Exact username matches first, then shorter usernames.
// Served by the unique username index and idx_users_display_name
// (migration 045). Values: caller, prefix, prefix, caller, caller, prefix.
export const AUTOCOMPLETE_SQL = `SELECT u.username, u.display_name, u.avatar_media_id
       FROM users u
       WHERE u.deleted_at IS NULL
         AND u.id <> ?
         AND (u.username LIKE ? ESCAPE '=' OR u.display_name LIKE ? ESCAPE '=')
         AND NOT ${eitherBlockedSql('u.id', '?')}
       ORDER BY u.username LIKE ? ESCAPE '=' DESC, CHAR_LENGTH(u.username), u.username
       LIMIT ${AUTOCOMPLETE_LIMIT}`;

interface SuggestionRow extends RowDataPacket {
  username: string;
  display_name: string | null;
  avatar_media_id: string | null;
}

@Injectable()
export class UserAutocompleteService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async suggest(callerId: string, query: string): Promise<UserSuggestionList> {
    const prefix = `${escapeLikeSearch(query.trim())}%`;
    const [rows] = await this.pool.execute<SuggestionRow[]>(AUTOCOMPLETE_SQL, [
      callerId,
      prefix,
      prefix,
      callerId,
      callerId,
      prefix,
    ]);
    const avatars = await loadMediaByIds(
      this.pool,
      rows.map((row) => row.avatar_media_id),
    );
    return {
      items: rows.map((row) => ({
        username: row.username,
        display_name: row.display_name,
        avatar_url:
          (row.avatar_media_id && avatars.get(row.avatar_media_id)?.url) ||
          null,
      })),
    };
  }
}
