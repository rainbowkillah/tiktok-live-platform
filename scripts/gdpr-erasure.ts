import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

type QueryResultRow = Record<string, unknown>;

type QueryResult = {
  rows: QueryResultRow[];
  rowCount: number | null;
};

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

type ErasureTarget = {
  userId?: string;
  uniqueId?: string;
};

type ErasureOptions = ErasureTarget & {
  auditRuleId: string;
  now?: Date;
};

type ErasureSummary = {
  timestamp: string;
  target: 'userId' | 'uniqueId';
  pseudonymizedUserId: string;
  pseudonymizedUniqueId: string;
  rowsAffected: {
    events: number;
    users: number;
    actionsLog: number;
  };
  tablesTouched: string[];
};

const ERASED_DISPLAY_NAME = '[erased]';
const ERASED_MESSAGE = '[erased]';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scrubEventDataNode(
  node: unknown,
  replacements: { userId: string; uniqueId: string }
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => scrubEventDataNode(item, replacements));
  }

  if (!isObject(node)) {
    return node;
  }

  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (key === 'userId' || key === 'tiktok_user_id') {
      output[key] = replacements.userId;
      continue;
    }

    if (key === 'uniqueId') {
      output[key] = replacements.uniqueId;
      continue;
    }

    if (key === 'displayName' || key === 'display_name') {
      output[key] = ERASED_DISPLAY_NAME;
      continue;
    }

    if (key === 'avatarUrl' || key === 'avatar_url') {
      output[key] = null;
      continue;
    }

    if (key === 'message') {
      output[key] = ERASED_MESSAGE;
      continue;
    }

    output[key] = scrubEventDataNode(value, replacements);
  }

  return output;
}

function toText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string for ${label}`);
  }

  return value;
}

function makePseudonyms(originalUserId: string, originalUniqueId: string, now: Date): {
  userId: string;
  uniqueId: string;
  displayName: string;
  avatarUrl: string;
  userHash: string;
  uniqueHash: string;
} {
  const salt = `${randomUUID()}:${now.toISOString()}`;
  const base = sha256(`${originalUserId}:${originalUniqueId}:${salt}`);
  const userId = `anon_${sha256(`uid:${base}`).slice(0, 24)}`;
  const uniqueId = `anon_${sha256(`unique:${base}`).slice(0, 24)}`;
  const displayName = `erased_${sha256(`display:${base}`).slice(0, 20)}`;
  const avatarUrl = `erased_${sha256(`avatar:${base}`).slice(0, 20)}`;

  return {
    userId,
    uniqueId,
    displayName,
    avatarUrl,
    userHash: sha256(originalUserId),
    uniqueHash: sha256(originalUniqueId),
  };
}

export async function runGdprErasure(db: Queryable, options: ErasureOptions): Promise<ErasureSummary> {
  const { userId, uniqueId, auditRuleId } = options;

  if (!userId && !uniqueId) {
    throw new Error('Provide --userId or --uniqueId');
  }

  if (!auditRuleId) {
    throw new Error('Missing audit rule id (use --audit-rule-id or GDPR_AUDIT_RULE_ID)');
  }

  const now = options.now ?? new Date();
  const startedAt = Date.now();

  await db.query('BEGIN');

  try {
    const lookup = await db.query(
      `SELECT tiktok_user_id, unique_id
       FROM users
       WHERE ($1::text IS NULL OR tiktok_user_id = $1::text)
         AND ($2::text IS NULL OR unique_id = $2::text)
       LIMIT 2`,
      [userId ?? null, uniqueId ?? null]
    );

    if (lookup.rowCount === 0) {
      throw new Error('User not found');
    }

    if ((lookup.rowCount ?? 0) > 1) {
      throw new Error('Lookup was ambiguous; refine --userId/--uniqueId');
    }

    const originalUserId = toText(lookup.rows[0].tiktok_user_id, 'users.tiktok_user_id');
    const originalUniqueId = toText(lookup.rows[0].unique_id, 'users.unique_id');
    const pseudonyms = makePseudonyms(originalUserId, originalUniqueId, now);

    const events = await db.query(
      `SELECT event_id, event_data
       FROM events
       WHERE user_id = $1
          OR event_data->'user'->>'userId' = $1
          OR event_data->'user'->>'uniqueId' = $2`,
      [originalUserId, originalUniqueId]
    );

    let updatedEvents = 0;
    for (const row of events.rows) {
      const eventId = toText(row.event_id, 'events.event_id');
      const scrubbed = scrubEventDataNode(row.event_data, {
        userId: pseudonyms.userId,
        uniqueId: pseudonyms.uniqueId,
      });

      const updateResult = await db.query(
        `UPDATE events
         SET user_id = $2,
             event_data = $3::jsonb
         WHERE event_id = $1`,
        [eventId, pseudonyms.userId, JSON.stringify(scrubbed)]
      );

      updatedEvents += updateResult.rowCount ?? 0;
    }

    const usersUpdate = await db.query(
      `UPDATE users
       SET tiktok_user_id = $2,
           unique_id = $3,
           display_name = $4,
           avatar_url = $5
       WHERE tiktok_user_id = $1`,
      [
        originalUserId,
        pseudonyms.userId,
        pseudonyms.uniqueId,
        pseudonyms.displayName,
        pseudonyms.avatarUrl,
      ]
    );

    if ((usersUpdate.rowCount ?? 0) !== 1) {
      throw new Error('Expected exactly one users row to be pseudonymized');
    }

    const summary: ErasureSummary = {
      timestamp: now.toISOString(),
      target: userId ? 'userId' : 'uniqueId',
      pseudonymizedUserId: pseudonyms.userId,
      pseudonymizedUniqueId: pseudonyms.uniqueId,
      rowsAffected: {
        events: updatedEvents,
        users: usersUpdate.rowCount ?? 0,
        actionsLog: 0,
      },
      tablesTouched: ['events', 'users', 'actions_log'],
    };

    const actionLogResult = await db.query(
      `INSERT INTO actions_log (
          id,
          rule_id,
          event_id,
          rendered_template,
          status,
          error,
          duration_ms,
          stream_id,
          session_id,
          meta
        )
        VALUES ($1, $2, $3, $4, 'success', NULL, $5, NULL, NULL, $6::jsonb)`,
      [
        randomUUID(),
        auditRuleId,
        `gdpr-erasure:${pseudonyms.userId}:${now.toISOString()}`,
        `GDPR erasure completed for ${pseudonyms.userId}`,
        Date.now() - startedAt,
        JSON.stringify({
          operation: 'gdpr-erasure',
          timestamp: summary.timestamp,
          targetType: summary.target,
          originalUserIdHash: pseudonyms.userHash,
          originalUniqueIdHash: pseudonyms.uniqueHash,
          rowsAffected: summary.rowsAffected,
        }),
      ]
    );

    summary.rowsAffected.actionsLog = actionLogResult.rowCount ?? 0;

    await db.query('COMMIT');
    return summary;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

type CliArgs = ErasureTarget & {
  databaseUrl?: string;
  auditRuleId?: string;
  help?: boolean;
};

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    const next = argv[i + 1];

    if (value === '--help' || value === '-h') {
      args.help = true;
      continue;
    }

    if (value === '--userId' && next) {
      args.userId = next;
      i += 1;
      continue;
    }

    if (value.startsWith('--userId=')) {
      args.userId = value.slice('--userId='.length);
      continue;
    }

    if (value === '--uniqueId' && next) {
      args.uniqueId = next;
      i += 1;
      continue;
    }

    if (value.startsWith('--uniqueId=')) {
      args.uniqueId = value.slice('--uniqueId='.length);
      continue;
    }

    if (value === '--database-url' && next) {
      args.databaseUrl = next;
      i += 1;
      continue;
    }

    if (value.startsWith('--database-url=')) {
      args.databaseUrl = value.slice('--database-url='.length);
      continue;
    }

    if (value === '--audit-rule-id' && next) {
      args.auditRuleId = next;
      i += 1;
      continue;
    }

    if (value.startsWith('--audit-rule-id=')) {
      args.auditRuleId = value.slice('--audit-rule-id='.length);
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  return args;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run gdpr:erase -- --userId <id> --audit-rule-id <uuid>',
    '  npm run gdpr:erase -- --uniqueId <name> --audit-rule-id <uuid>',
    '',
    'Options:',
    '  --userId <id>           TikTok user id',
    '  --uniqueId <name>       TikTok unique id',
    '  --database-url <url>    Postgres connection string (defaults to DATABASE_URL)',
    '  --audit-rule-id <uuid>  Existing rules.id used for actions_log audit row',
    '  -h, --help              Print this help',
  ].join('\n');
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(usage());
    return;
  }

  const databaseUrl = cli.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (or pass --database-url)');
  }

  const auditRuleId = cli.auditRuleId ?? process.env.GDPR_AUDIT_RULE_ID;
  if (!auditRuleId) {
    throw new Error('GDPR_AUDIT_RULE_ID is required (or pass --audit-rule-id)');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    const summary = await runGdprErasure(client, {
      userId: cli.userId,
      uniqueId: cli.uniqueId,
      auditRuleId,
    });

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`GDPR erasure failed: ${message}`);
    process.exit(1);
  });
}

export { scrubEventDataNode, parseCliArgs };
