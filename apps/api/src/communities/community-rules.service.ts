import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { hashCommunityRules, CommunityRuleItem } from './community-rules-hash';
import { ListRuleVersionsDto } from './dto/list-rule-versions.dto';
import { PublishCommunityRulesDto } from './dto/publish-community-rules.dto';

interface RuleCommunityRow extends RowDataPacket {
  id: string;
  creator_id: string;
}

interface RuleDocumentRow extends RowDataPacket {
  id: string;
  version: number;
  content_hash: string;
  published_at: Date | string;
}

interface RuleItemRow extends RowDataPacket {
  position: number;
  title: string;
  body: string | null;
}

interface RuleVersionRow extends RowDataPacket {
  version: number;
  published_at: Date | string;
  published_by_username: string | null;
  rule_count: number | string;
}

export interface CommunityRulesDto {
  version: number | null;
  published_at: string | null;
  items: CommunityRuleItem[];
}

export interface CommunityRuleVersionDto {
  version: number;
  published_at: string;
  published_by_username: string | null;
  rule_count: number;
}

export interface CommunityRuleVersionListDto {
  items: CommunityRuleVersionDto[];
  page: number;
  limit: number;
  total: number;
}

const NO_RULES: CommunityRulesDto = {
  version: null,
  published_at: null,
  items: [],
};

// The only authorization rule for publishing. Moderators are deliberately
// excluded for now (see "Community rules" in apps/api/README.md); permitting
// them means changing this function and its test, nothing else.
export function canPublishCommunityRules(
  community: { creator_id: string },
  actorId: string,
): boolean {
  return community.creator_id === actorId;
}

@Injectable()
export class CommunityRulesService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async getCurrent(name: string): Promise<CommunityRulesDto> {
    const community = await this.getCommunity(this.pool, name);
    const document = await this.getCurrentDocument(this.pool, community.id);
    return document ? this.toRulesDto(this.pool, document) : { ...NO_RULES };
  }

  async getVersion(name: string, version: number): Promise<CommunityRulesDto> {
    const community = await this.getCommunity(this.pool, name);
    const [documents] = await this.pool.execute<RuleDocumentRow[]>(
      `SELECT id, version, content_hash, published_at
       FROM community_rule_documents
       WHERE community_id = ? AND version = ?
       LIMIT 1`,
      [community.id, version],
    );
    const document = documents[0];
    if (!document) {
      throw new NotFoundException('Rule version not found');
    }
    return this.toRulesDto(this.pool, document);
  }

  async listVersions(
    name: string,
    query: ListRuleVersionsDto,
  ): Promise<CommunityRuleVersionListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const community = await this.getCommunity(this.pool, name);

    // LEFT JOIN: a deleted publisher leaves published_by NULL.
    const [versions] = await this.pool.execute<RuleVersionRow[]>(
      `SELECT d.version, d.published_at, u.username AS published_by_username,
         (SELECT COUNT(*) FROM community_rules r WHERE r.document_id = d.id) AS rule_count
       FROM community_rule_documents d
       LEFT JOIN users u ON u.id = d.published_by
       WHERE d.community_id = ?
       ORDER BY d.version DESC LIMIT ? OFFSET ?`,
      [community.id, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number })[]
    >(
      'SELECT COUNT(*) AS total FROM community_rule_documents WHERE community_id = ?',
      [community.id],
    );

    return {
      items: versions.map((row) => ({
        version: row.version,
        published_at: new Date(row.published_at).toISOString(),
        published_by_username: row.published_by_username ?? null,
        rule_count: Number(row.rule_count),
      })),
      page,
      limit,
      total: countRows[0].total,
    };
  }

  // Publishes the submitted items as a new version unless they hash equal to
  // the current document, in which case the current version is returned and
  // nothing is written.
  async publish(
    name: string,
    input: PublishCommunityRulesDto,
    actorId: string,
  ): Promise<CommunityRulesDto> {
    // Position is the array index, so stored order always matches the request.
    const items: CommunityRuleItem[] = input.items.map((item, index) => ({
      position: index + 1,
      title: item.title,
      body: item.body ?? null,
    }));
    const contentHash = hashCommunityRules(items);

    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      // Locking the community row serialises concurrent publishes for the
      // same community; the (community_id, version) unique key is the
      // backstop if two still race.
      const community = await this.getCommunity(connection, name, true);
      if (!canPublishCommunityRules(community, actorId)) {
        throw new ForbiddenException(
          'Only the community creator can publish rules',
        );
      }

      const current = await this.getCurrentDocument(connection, community.id);
      if (current && current.content_hash === contentHash) {
        const unchanged = await this.toRulesDto(connection, current);
        await connection.commit();
        return unchanged;
      }

      const documentId = randomUUID();
      const version = (current?.version ?? 0) + 1;
      await connection.execute<ResultSetHeader>(
        `INSERT INTO community_rule_documents
           (id, community_id, version, content_hash, published_by)
         VALUES (?, ?, ?, ?, ?)`,
        [documentId, community.id, version, contentHash, actorId],
      );
      await connection.execute<ResultSetHeader>(
        `INSERT INTO community_rules (id, document_id, position, title, body)
         VALUES ${items.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
        items.flatMap((item) => [
          randomUUID(),
          documentId,
          item.position,
          item.title,
          item.body,
        ]),
      );

      // published_at comes from the database clock.
      const [published] = await connection.execute<
        (RowDataPacket & { published_at: Date | string })[]
      >(
        'SELECT published_at FROM community_rule_documents WHERE id = ? LIMIT 1',
        [documentId],
      );
      if (!published[0]) {
        throw new Error('Published rule document could not be retrieved');
      }

      await connection.commit();
      return {
        version,
        published_at: new Date(published[0].published_at).toISOString(),
        items,
      };
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      if (this.isDuplicateEntry(error)) {
        throw new ConflictException(
          'Rules were published concurrently; retry the request',
        );
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  private async getCommunity(
    executor: Pool | PoolConnection,
    name: string,
    forUpdate = false,
  ): Promise<RuleCommunityRow> {
    const [communities] = await executor.execute<RuleCommunityRow[]>(
      `SELECT id, creator_id FROM communities WHERE name = ? LIMIT 1${
        forUpdate ? ' FOR UPDATE' : ''
      }`,
      [name],
    );
    const community = communities[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community;
  }

  // The current document is the highest version, never the latest
  // published_at, matching CommunityRuleAcceptanceService.
  private async getCurrentDocument(
    executor: Pool | PoolConnection,
    communityId: string,
  ): Promise<RuleDocumentRow | undefined> {
    const [documents] = await executor.execute<RuleDocumentRow[]>(
      `SELECT id, version, content_hash, published_at
       FROM community_rule_documents
       WHERE community_id = ?
       ORDER BY version DESC
       LIMIT 1`,
      [communityId],
    );
    return documents[0];
  }

  private async toRulesDto(
    executor: Pool | PoolConnection,
    document: RuleDocumentRow,
  ): Promise<CommunityRulesDto> {
    const [items] = await executor.execute<RuleItemRow[]>(
      'SELECT position, title, body FROM community_rules WHERE document_id = ? ORDER BY position ASC',
      [document.id],
    );
    return {
      version: document.version,
      published_at: new Date(document.published_at).toISOString(),
      items: items.map((item) => ({
        position: item.position,
        title: item.title,
        body: item.body,
      })),
    };
  }

  private isDuplicateEntry(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ER_DUP_ENTRY'
    );
  }
}
