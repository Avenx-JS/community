import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { CreatePostDto, isValidPostContent } from './create-post.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const parse = (body: Record<string, unknown>) =>
  pipe.transform(
    { title: 'Title', community_id: 'community-1', ...body },
    { type: 'body', metatype: CreatePostDto },
  );

describe('CreatePostDto', () => {
  it.each([
    { type: 'text', content: 'A body' },
    { type: 'link', content: 'https://example.com/article' },
    { type: 'media', media_id: 'media-1' },
    { type: 'media', media_id: 'media-1', content: '  My tomatoes  ' },
    // A caption is plain text, a URL included.
    { type: 'media', media_id: 'media-1', content: 'https://example.com' },
  ])('accepts %o', async (body) => {
    await expect(parse(body)).resolves.toMatchObject(
      body.content?.includes(' My') ? { content: 'My tomatoes' } : body,
    );
  });

  // Breaking change (migration 035): a media post takes an upload, never a
  // URL; text and link posts never take an upload.
  it.each([
    { type: 'media', content: 'https://example.com/image.png' },
    { type: 'media' },
    { type: 'media', media_id: '' },
    { type: 'media', media_id: 'has spaces' },
    { type: 'media', media_id: 'x'.repeat(37) },
    { type: 'media', media_id: 'media-1', content: '' },
    { type: 'media', media_id: 'media-1', content: 'bad\u0000text' },
    { type: 'text', content: 'A body', media_id: 'media-1' },
    { type: 'link', content: 'https://example.com', media_id: 'media-1' },
    { type: 'text' },
    { type: 'link' },
    { type: 'link', content: 'not a url' },
  ])('refuses %o', async (body) => {
    await expect(parse(body)).rejects.toThrow();
  });
});

describe('isValidPostContent', () => {
  it('applies the URL rule to link posts and to media posts without a file', () => {
    expect(isValidPostContent('link', 'just text')).toBe(false);
    expect(isValidPostContent('media', 'just text', false)).toBe(false);
    expect(
      isValidPostContent('media', 'https://example.com/a.png', false),
    ).toBe(true);
  });

  it('takes any caption on a media post with a file, and any text on a text post', () => {
    expect(isValidPostContent('media', 'just text', true)).toBe(true);
    expect(isValidPostContent('media', 'just text')).toBe(true);
    expect(isValidPostContent('text', 'just text')).toBe(true);
  });
});
