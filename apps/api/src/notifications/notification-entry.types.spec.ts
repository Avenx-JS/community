import { describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import type { NotificationEntry } from './notification-metadata';

// Compile-only fixtures. Jest transpiles without type checking, so the test
// below runs the compiler over this file: every @ts-expect-error must match a
// real error, or TypeScript reports it as unused (TS2578).
// A mismatch the compiler cannot pin to one property is reported on the
// declaration, so those fixtures are declared on their own.
export function typeFixtures(): NotificationEntry[] {
  // @ts-expect-error post_comment is about a comment, not a post.
  const wrongSubject: NotificationEntry = {
    recipientId: 'r',
    type: 'post_comment',
    actorId: 'a',
    subjectType: 'post',
    subjectId: 's',
    communityId: 'c',
    metadata: { post_id: 'p', post_title: 't', excerpt: 'e' },
  };
  // @ts-expect-error moderation notifications never name an actor.
  const moderationActor: NotificationEntry = {
    recipientId: 'r',
    type: 'restriction_applied',
    actorId: 'admin',
    subjectType: 'restriction',
    subjectId: 's',
    communityId: null,
    metadata: { restriction_type: 'ban' },
  };

  return [
    wrongSubject,
    moderationActor,
    {
      recipientId: 'r',
      type: 'report_resolved',
      actorId: null,
      subjectType: 'report',
      subjectId: 's',
      communityId: null,
      // @ts-expect-error a report outcome is resolved or rejected.
      metadata: { status: 'open' },
    },
    {
      recipientId: 'r',
      // @ts-expect-error the type must be one of the enum values.
      type: 'vote',
      actorId: 'a',
      subjectType: 'post',
      subjectId: 's',
      communityId: 'c',
      metadata: {},
    },
    {
      recipientId: 'r',
      type: 'content_removed',
      actorId: null,
      subjectType: 'comment',
      subjectId: 's',
      communityId: 'c',
      metadata: {},
    },
  ];
}

describe('NotificationEntry type', () => {
  it('rejects mismatched type, subject, actor and metadata at compile time', () => {
    const configPath = resolve(__dirname, '../../tsconfig.json');
    const config = ts.getParsedCommandLineOfConfigFile(
      configPath,
      { noEmit: true, incremental: false },
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    );
    if (!config) {
      throw new Error('tsconfig.json could not be parsed');
    }

    const program = ts.createProgram([__filename], config.options);
    const diagnostics = ts
      .getPreEmitDiagnostics(program, program.getSourceFile(__filename))
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      );

    expect(diagnostics).toEqual([]);
    expect(typeFixtures()).toHaveLength(5);
  }, 60_000);
});
