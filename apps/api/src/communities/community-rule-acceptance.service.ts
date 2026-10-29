import { Inject, Injectable } from '@nestjs/common';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';

interface CurrentDocumentRow extends RowDataPacket {
  document_id: string;
  version: number;
  accepted_at: Date | string | null;
}

export interface RuleAcceptanceState {
  currentVersion: number | null;
  currentDocumentId: string | null;
  acceptedAt: string | null;
  acceptanceRequired: boolean;
}

// The single source of truth for "must this user accept this community's
// rules?". Pass the caller's connection to run inside its transaction.
@Injectable()
export class CommunityRuleAcceptanceService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async getState(
    userId: string,
    communityId: string,
    connection: Pool | PoolConnection = this.pool,
  ): Promise<RuleAcceptanceState> {
    // The current document is the highest version, never the latest
    // published_at, so a clock anomaly cannot change the answer.
    const [rows] = await connection.execute<CurrentDocumentRow[]>(
      `SELECT d.id AS document_id, d.version, a.accepted_at
       FROM community_rule_documents d
       LEFT JOIN community_rule_acceptances a
         ON a.document_id = d.id AND a.user_id = ?
       WHERE d.community_id = ?
       ORDER BY d.version DESC
       LIMIT 1`,
      [userId, communityId],
    );
    const current = rows[0];

    // A community without published rules has nothing to accept.
    if (!current) {
      return {
        currentVersion: null,
        currentDocumentId: null,
        acceptedAt: null,
        acceptanceRequired: false,
      };
    }

    return {
      currentVersion: current.version,
      currentDocumentId: current.document_id,
      acceptedAt:
        current.accepted_at === null
          ? null
          : new Date(current.accepted_at).toISOString(),
      acceptanceRequired: current.accepted_at === null,
    };
  }

  // Resolves the document and its community_id in the same statement, so the
  // stored community can never drift from the document, and the database
  // clock sets accepted_at. Repeating an acceptance keeps the original time.
  // Returns false when the community has no document with that version.
  // Relies on mysql2's default FOUND_ROWS flag, which counts a repeated
  // acceptance as a matched row.
  async accept(
    userId: string,
    communityId: string,
    version: number,
    connection: Pool | PoolConnection = this.pool,
  ): Promise<boolean> {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO community_rule_acceptances (user_id, document_id, community_id)
       SELECT ?, d.id, d.community_id
       FROM community_rule_documents d
       WHERE d.community_id = ? AND d.version = ?
       ON DUPLICATE KEY UPDATE accepted_at = accepted_at`,
      [userId, communityId, version],
    );
    return result.affectedRows > 0;
  }
}
