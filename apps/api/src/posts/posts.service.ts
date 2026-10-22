import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { CreatePostDto } from './dto/create-post.dto';
import { ListPostsDto } from './dto/list-posts.dto';

interface PostRow extends RowDataPacket {
  id: string;
  title: string;
  content: string | null;
  type: 'text' | 'link' | 'media';
  author_id: string;
  community_id: string;
  created_at: Date | string;
}

export interface PostDto {
  id: string;
  title: string;
  content: string | null;
  type: 'text' | 'link' | 'media';
  author_id: string;
  community_id: string;
  created_at: string;
}

export interface PostListDto {
  items: PostDto[];
  page: number;
  limit: number;
  total: number;
  sort: 'new';
}

@Injectable()
export class PostsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async findAll(query: ListPostsDto): Promise<PostListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const where = query.community_id ? ' WHERE community_id = ?' : '';
    const values: (string | number)[] = query.community_id
      ? [query.community_id]
      : [];
    const [posts] = await this.pool.execute<PostRow[]>(
      `SELECT id, title, content, type, author_id, community_id, created_at FROM posts${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number })[]
    >(`SELECT COUNT(*) AS total FROM posts${where}`, values);

    return {
      items: posts.map((post) => this.toDto(post)),
      page,
      limit,
      total: countRows[0].total,
      sort: 'new',
    };
  }

  async create(input: CreatePostDto, authorId: string): Promise<PostDto> {
    const [communities] = await this.pool.execute<
      (RowDataPacket & { id: string })[]
    >('SELECT id FROM communities WHERE id = ? LIMIT 1', [input.community_id]);

    if (!communities[0]) {
      throw new NotFoundException('Community not found');
    }

    const id = randomUUID();
    await this.pool.execute<ResultSetHeader>(
      'INSERT INTO posts (id, title, content, type, author_id, community_id) VALUES (?, ?, ?, ?, ?, ?)',
      [
        id,
        input.title.trim(),
        input.content.trim(),
        input.type,
        authorId,
        input.community_id,
      ],
    );

    const [posts] = await this.pool.execute<PostRow[]>(
      'SELECT id, title, content, type, author_id, community_id, created_at FROM posts WHERE id = ? LIMIT 1',
      [id],
    );
    const post = posts[0];

    if (!post) {
      throw new Error('Created post could not be retrieved');
    }

    return this.toDto(post);
  }

  async findOne(id: string): Promise<PostDto> {
    const [posts] = await this.pool.execute<PostRow[]>(
      'SELECT id, title, content, type, author_id, community_id, created_at FROM posts WHERE id = ? LIMIT 1',
      [id],
    );
    const post = posts[0];

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    return this.toDto(post);
  }

  async remove(id: string, authorId: string): Promise<void> {
    const [posts] = await this.pool.execute<
      (RowDataPacket & { author_id: string })[]
    >('SELECT author_id FROM posts WHERE id = ? LIMIT 1', [id]);
    const post = posts[0];

    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (post.author_id !== authorId) {
      throw new ForbiddenException('You can only delete your own posts');
    }

    const [result] = await this.pool.execute<ResultSetHeader>(
      'DELETE FROM posts WHERE id = ? AND author_id = ?',
      [id, authorId],
    );

    if (result.affectedRows === 0) {
      throw new NotFoundException('Post not found');
    }
  }

  private toDto(post: PostRow): PostDto {
    return {
      id: post.id,
      title: post.title,
      content: post.content,
      type: post.type,
      author_id: post.author_id,
      community_id: post.community_id,
      created_at: new Date(post.created_at).toISOString(),
    };
  }
}
