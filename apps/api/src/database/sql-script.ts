// Splits an SQL script into chunks that can each be sent with one
// multiple-statement query, honouring the mysql client's DELIMITER command.
//
// Trigger bodies (BEGIN ... END) contain semicolons, so data/community.sql and
// the migrations that create triggers switch the delimiter around them, which
// the mysql CLI and Workbench understand but the server does not. Text under
// the default ";" delimiter stays one chunk, exactly as before; every
// statement under another delimiter becomes its own chunk, without its
// delimiter. A DELIMITER line must stand alone, as in the mysql client.
export function splitSqlScript(sql: string): string[] {
  const chunks: string[] = [];
  let delimiter = ';';
  let buffer: string[] = [];

  const flush = () => {
    const chunk = buffer.join('\n').trim();
    if (chunk && !isOnlyComments(chunk)) {
      chunks.push(chunk);
    }
    buffer = [];
  };

  for (const line of sql.split(/\r?\n/)) {
    const command = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(line);
    if (command) {
      flush();
      delimiter = command[1];
      continue;
    }
    if (delimiter === ';') {
      buffer.push(line);
      continue;
    }
    const trimmed = line.trimEnd();
    if (trimmed.endsWith(delimiter)) {
      buffer.push(trimmed.slice(0, -delimiter.length));
      flush();
    } else {
      buffer.push(line);
    }
  }
  if (delimiter !== ';' && buffer.some((line) => line.trim())) {
    throw new Error(
      `Unterminated statement before end of script (DELIMITER ${delimiter})`,
    );
  }
  flush();
  return chunks;
}

function isOnlyComments(chunk: string): boolean {
  return chunk
    .split('\n')
    .every((line) => line.trim() === '' || line.trim().startsWith('--'));
}

// Removes the trigger pair that enforces each named rule, including the
// marker comment and the DELIMITER lines around it, from a script in the
// format data/community.sql uses. The migration specs use it to rebuild the
// snapshot as it was before a migration.
export function removeTriggerRules(sql: string, ...rules: string[]): string {
  return rules.reduce((script, rule) => {
    const block = new RegExp(
      `^-- ${rule} \\([^\\n]*\\n[\\s\\S]*?^DELIMITER ;[^\\S\\n]*\\r?\\n(?:[^\\S\\n]*\\r?\\n)?`,
      'm',
    );
    if (!block.test(script)) {
      throw new Error(`No trigger block for ${rule}`);
    }
    return script.replace(block, '');
  }, sql);
}

// Runs a script chunk by chunk on one connection, so session state such as
// USE carries over. The connection must allow multiple statements.
export async function runSqlScript(
  connection: { query(sql: string): Promise<unknown> },
  sql: string,
): Promise<void> {
  for (const chunk of splitSqlScript(sql)) {
    await connection.query(chunk);
  }
}
