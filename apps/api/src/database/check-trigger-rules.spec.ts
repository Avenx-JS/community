import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHECK_TRIGGER_RULES, checkTriggerSql } from './check-trigger-rules';
import { removeTriggerRules, splitSqlScript } from './sql-script';

const read = (path: string) =>
  readFileSync(resolve(__dirname, path), 'utf8').replace(/\r\n/g, '\n');
const snapshot = read('../../../../data/community.sql');
const migration = (version: string) =>
  read(`../../../../data/migrations/${version}.sql`);

// Every CHECK constraint in a CREATE TABLE or ALTER TABLE that names a column
// whose foreign key has a referential action: MySQL 8 refuses each one with
// error 3823, so none may exist.
function checksOnReferentialColumns(sql: string): string[] {
  const found: string[] = [];
  for (const [, table, body] of sql.matchAll(
    /(?:CREATE|ALTER) TABLE (\w+)([\s\S]*?)(?:\n\);|;\n)/g,
  )) {
    const columns = [
      ...body.matchAll(
        /FOREIGN KEY \((\w+)\) REFERENCES \w+\(\w+\) ON (?:DELETE|UPDATE) (?:SET NULL|CASCADE)/g,
      ),
    ].map((match) => match[1]);
    for (const [, name, clause] of body.matchAll(
      /CONSTRAINT (\w+) CHECK \(([\s\S]*?)\)\s*(?:,|$)/g,
    )) {
      if (
        columns.some((column) => new RegExp(`\\b${column}\\b`).test(clause))
      ) {
        found.push(`${table}.${name}`);
      }
    }
  }
  return found;
}

describe('check trigger rules', () => {
  it('leaves no CHECK on a column with a foreign-key referential action', () => {
    expect(checksOnReferentialColumns(snapshot)).toEqual([]);
    for (const version of new Set(
      CHECK_TRIGGER_RULES.map((rule) => rule.migration),
    )) {
      expect([version, checksOnReferentialColumns(migration(version))]).toEqual(
        [version, []],
      );
    }
  });

  it.each(CHECK_TRIGGER_RULES.map((rule) => [rule.name, rule] as const))(
    'renders %s in its migration and in the snapshot, and nowhere as a CHECK',
    (name, rule) => {
      const block = checkTriggerSql(rule);
      expect(migration(rule.migration)).toContain(block);
      expect(snapshot).toContain(block);
      expect(snapshot).not.toMatch(new RegExp(`CONSTRAINT ${name} CHECK`));
      expect(migration(rule.migration)).not.toMatch(
        new RegExp(`CONSTRAINT ${name} CHECK`),
      );
    },
  );

  it('creates the snapshot triggers in migration order', () => {
    const order = [...snapshot.matchAll(/^-- (chk_\w+) \(/gm)].map(
      (match) => match[1],
    );
    expect(order).toEqual(CHECK_TRIGGER_RULES.map((rule) => rule.name));
  });

  it('keeps each block removable, leaving no trigger behind', () => {
    const stripped = removeTriggerRules(
      snapshot,
      ...CHECK_TRIGGER_RULES.map((rule) => rule.name),
    );
    expect(stripped).not.toMatch(/CREATE TRIGGER|DELIMITER/);
  });

  it('splits each trigger into its own statement for the server', () => {
    const chunks = splitSqlScript(snapshot);
    const triggers = chunks.filter((chunk) =>
      chunk.startsWith('CREATE TRIGGER'),
    );
    expect(triggers).toHaveLength(CHECK_TRIGGER_RULES.length * 2);
    for (const chunk of triggers) {
      expect(chunk).toMatch(/^CREATE TRIGGER \w+ BEFORE (INSERT|UPDATE) ON/);
      expect(chunk).toMatch(/END$/);
      expect(chunk).not.toContain('$$');
    }
  });
});

describe('splitSqlScript', () => {
  it('keeps text under the default delimiter as one chunk', () => {
    expect(
      splitSqlScript('CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\n'),
    ).toEqual(['CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);']);
  });

  it('sends each statement under a custom delimiter alone, without it', () => {
    expect(
      splitSqlScript(
        [
          'CREATE TABLE a (id INT);',
          'DELIMITER $$',
          'CREATE TRIGGER t1 BEFORE INSERT ON a FOR EACH ROW',
          'BEGIN',
          '  SET NEW.id = 1;',
          'END$$',
          'CREATE TRIGGER t2 BEFORE UPDATE ON a FOR EACH ROW',
          'BEGIN',
          '  SET NEW.id = 2;',
          'END$$',
          'DELIMITER ;',
          'CREATE TABLE b (id INT);',
        ].join('\r\n'),
      ),
    ).toEqual([
      'CREATE TABLE a (id INT);',
      'CREATE TRIGGER t1 BEFORE INSERT ON a FOR EACH ROW\nBEGIN\n  SET NEW.id = 1;\nEND',
      'CREATE TRIGGER t2 BEFORE UPDATE ON a FOR EACH ROW\nBEGIN\n  SET NEW.id = 2;\nEND',
      'CREATE TABLE b (id INT);',
    ]);
  });

  it('drops chunks that hold only comments', () => {
    expect(
      splitSqlScript('-- just a note\nDELIMITER $$\nDELIMITER ;\n'),
    ).toEqual([]);
  });

  it('refuses a script that ends inside a custom-delimiter statement', () => {
    expect(() =>
      splitSqlScript(
        'DELIMITER $$\nCREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW SET NEW.id = 1;',
      ),
    ).toThrow('Unterminated statement');
  });
});
