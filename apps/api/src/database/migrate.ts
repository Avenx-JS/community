import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';

export interface Migration {
  version: string;
  order: number;
  sql: string;
}

export interface MigrationConnection {
  execute(sql: string, values?: string[]): Promise<[unknown, unknown]>;
  query(sql: string): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

const migrationFilenamePattern = /^(\d{3,})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export function parseMigrationFilename(filename: string): Migration['order'] {
  const match = migrationFilenamePattern.exec(filename);
  if (!match) {
    throw new Error(`Invalid migration filename: ${filename}`);
  }

  return Number(match[1]);
}

export function orderMigrations(migrations: Migration[]): Migration[] {
  const ordered = [...migrations].sort(
    (left, right) => left.order - right.order,
  );

  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].order === ordered[index].order) {
      throw new Error(`Duplicate migration order: ${ordered[index].order}`);
    }
  }

  return ordered;
}

export function filterPendingMigrations(
  migrations: Migration[],
  appliedVersions: Set<string>,
): Migration[] {
  return orderMigrations(migrations).filter(
    (migration) => !appliedVersions.has(migration.version),
  );
}

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const filenames = await readdir(directory);
  const migrations = await Promise.all(
    filenames
      .filter((filename) => filename.endsWith('.sql'))
      .map(async (filename) => {
        const order = parseMigrationFilename(filename);
        return {
          version: filename.slice(0, -'.sql'.length),
          order,
          sql: await readFile(resolve(directory, filename), 'utf8'),
        };
      }),
  );

  return orderMigrations(migrations);
}

function readAppliedVersions(rows: unknown): Set<string> {
  if (!Array.isArray(rows)) {
    throw new Error('Unexpected schema_migrations query result');
  }

  return new Set(
    rows.map((row: unknown) => {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('version' in row) ||
        typeof row.version !== 'string'
      ) {
        throw new Error('Unexpected schema_migrations row');
      }
      return row.version;
    }),
  );
}

export async function runMigrations(
  connection: MigrationConnection,
  migrations: Migration[],
  log: (message: string) => void,
): Promise<void> {
  await connection.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  const [rows] = await connection.execute(
    'SELECT version FROM schema_migrations',
  );
  const appliedVersions = readAppliedVersions(rows);

  for (const migration of orderMigrations(migrations)) {
    if (appliedVersions.has(migration.version)) {
      log(`Skipped ${migration.version} (already applied)`);
      continue;
    }

    try {
      await connection.query(migration.sql);
    } catch (error) {
      log(`Failed ${migration.version}; version was not recorded`);
      throw error;
    }
    try {
      await connection.execute(
        'INSERT INTO schema_migrations (version) VALUES (?)',
        [migration.version],
      );
    } catch (error) {
      log(`Applied ${migration.version}, but failed to record its version`);
      throw error;
    }
    log(`Applied ${migration.version}`);
  }
}

async function main(): Promise<void> {
  const user = process.env.MYSQL_USER;
  const database = process.env.MYSQL_DATABASE;
  if (!user || !database) {
    throw new Error('MYSQL_USER and MYSQL_DATABASE must be configured');
  }

  const mysqlConnection = await createConnection({
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user,
    password: process.env.MYSQL_PASSWORD,
    database,
    multipleStatements: true,
  });
  const connection: MigrationConnection = {
    execute: async (sql, values) => {
      const [result, fields] = await mysqlConnection.execute(sql, values);
      return [result, fields];
    },
    query: async (sql) => {
      const [result, fields] = await mysqlConnection.query(sql);
      return [result, fields];
    },
    end: () => mysqlConnection.end(),
  };

  try {
    const migrations = await loadMigrations(
      resolve(__dirname, '../../../../data/migrations'),
    );
    await runMigrations(connection, migrations, console.log);
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error(
      'Migration run failed. Check database connectivity and migration SQL.',
    );
    process.exitCode = 1;
  });
}
