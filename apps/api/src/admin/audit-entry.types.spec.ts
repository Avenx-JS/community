import { describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import type { AuditEntry } from './audit-log.service';

// Compile-only fixtures. Jest transpiles without type checking, so the test
// below runs the compiler over this file: every @ts-expect-error must match a
// real error, or TypeScript reports it as unused (TS2578).
// A mismatch the compiler cannot pin to one property is reported on the
// declaration, so those fixtures are declared on their own.
export function typeFixtures(): AuditEntry[] {
  // @ts-expect-error a community action targets a community, not a user.
  const suspendedUser: AuditEntry = {
    actorId: 'a',
    action: 'community_suspended',
    targetType: 'user',
    targetId: 't',
  };
  // @ts-expect-error a community action targets a community, not a report.
  const restoredReport: AuditEntry = {
    actorId: 'a',
    action: 'community_restored',
    targetType: 'report',
    targetId: 't',
  };
  // @ts-expect-error a community action targets a community, not a restriction.
  const updatedRestriction: AuditEntry = {
    actorId: 'a',
    action: 'community_updated',
    targetType: 'restriction',
    targetId: 't',
  };
  // @ts-expect-error an existing user action cannot target a community.
  const bannedCommunity: AuditEntry = {
    actorId: 'a',
    action: 'user_banned',
    targetType: 'community',
    targetId: 't',
  };

  return [
    suspendedUser,
    restoredReport,
    updatedRestriction,
    bannedCommunity,
    {
      actorId: 'a',
      action: 'community_suspended',
      targetType: 'community',
      targetId: 't',
      metadata: { community_name: 'spam-hub', reason: 'Spam' },
    },
    {
      actorId: 'a',
      action: 'community_restored',
      targetType: 'community',
      targetId: 't',
      // @ts-expect-error a restore records no reason.
      metadata: { community_name: 'spam-hub', reason: 'Appeal' },
    },
    {
      actorId: 'a',
      action: 'community_updated',
      targetType: 'community',
      targetId: 't',
      metadata: { community_name: 'spam-hub', fields: 'description' },
    },
  ];
}

describe('AuditEntry type', () => {
  it('pairs every community action with the community target at compile time', () => {
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
    expect(typeFixtures()).toHaveLength(7);
  }, 60_000);
});
