import { addAbortListener } from 'node:events';
import type { Sql } from './database.js';
import type { RuntimeConfig } from './runtime.js';

const DAY = 86_400_000;
export type ConversationVisibility = 'private' | 'public';
export type VisibilityResolver = (
  conversation: {
    id: string;
    scope: string;
  },
  signal: AbortSignal,
) => Promise<ConversationVisibility>;

const jobTables = ['rove_slack_job', 'rove_plugin_channel_job'] as const;
const unfinishedJobs =
  "status IN ('pending','processing','ready','delivering')";

export async function createConversationRetention(config: RuntimeConfig) {
  const { db, state } = config;
  await db.migrate(`
    ALTER TABLE rove_conversation ADD COLUMN IF NOT EXISTS archived_at BIGINT;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='rove_conversation'::regclass AND attname='last_activity_at' AND NOT attisdropped) THEN
        ALTER TABLE rove_conversation ADD COLUMN last_activity_at BIGINT;
        UPDATE rove_conversation AS old_conversation SET last_activity_at=GREATEST(updated_at,
          COALESCE((SELECT MAX(((data::jsonb)->'pending'->>'created')::bigint)
            FROM rove_run WHERE conversation=old_conversation.id),updated_at));
        ALTER TABLE rove_conversation ALTER COLUMN last_activity_at SET NOT NULL;
      END IF;
    END $$;
    ALTER TABLE rove_conversation ADD COLUMN IF NOT EXISTS expired_at BIGINT;
    ALTER TABLE rove_conversation ADD COLUMN IF NOT EXISTS title_redacted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE rove_conversation ADD COLUMN IF NOT EXISTS retention_checked_at BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE rove_exchange ADD COLUMN IF NOT EXISTS expired BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS rove_conversation_page ON rove_conversation(scope,updated_at DESC,id);
    CREATE INDEX IF NOT EXISTS rove_conversation_active_page ON rove_conversation(scope,updated_at DESC,id) WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS rove_conversation_archived_page ON rove_conversation(scope,updated_at DESC,id) WHERE archived_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS rove_conversation_retention ON rove_conversation(retention_checked_at,last_activity_at,id) WHERE expired_at IS NULL OR NOT title_redacted;
    CREATE INDEX IF NOT EXISTS rove_exchange_conversation ON rove_exchange(conversation_id,sequence) WHERE NOT expired;
  `);

  async function hasUnfinishedRun(tx: Sql, id: string) {
    return Boolean(
      await tx.get(
        "SELECT 1 FROM rove_run WHERE conversation=$1 AND status IS DISTINCT FROM 'done' LIMIT 1",
        [id],
      ),
    );
  }

  return async function purgeExpired(
    now: number,
    resolveVisibility: VisibilityResolver | undefined,
    signal: AbortSignal,
    withMutation: (action: () => Promise<boolean>) => Promise<boolean>,
  ) {
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error('Retention requires a valid timestamp.');
    await state.assertOwned();
    // Old public rows rotate behind unchecked rows even before their 90-day cutoff.
    const candidates = await db.all<{ id: string; scope: string }>(
      `SELECT id,scope FROM rove_conversation
       WHERE (expired_at IS NULL OR NOT title_redacted) AND last_activity_at <= $1
       ORDER BY retention_checked_at,last_activity_at,id LIMIT 200`,
      [now - 14 * DAY],
    );
    const tables: string[] = [];
    for (const table of jobTables)
      if ((await db.get('SELECT to_regclass($1) AS name', [table]))?.name)
        tables.push(table);
    let checked = 0;
    let expired = 0;
    for (const candidate of candidates) {
      signal.throwIfAborted();
      // Only Slack has an authoritative public visibility boundary in the MVP.
      let listener: ReturnType<typeof addAbortListener> | undefined;
      let visibility: ConversationVisibility = 'private';
      if (candidate.scope.startsWith('slack:') && resolveVisibility) {
        try {
          visibility = await Promise.race([
            resolveVisibility(candidate, signal).catch(
              () => 'private' as const,
            ),
            new Promise<never>((_, reject) => {
              listener = addAbortListener(signal, () => reject(signal.reason));
            }),
          ]);
        } finally {
          listener?.[Symbol.dispose]();
        }
      }
      signal.throwIfAborted();
      const cutoff = now - (visibility === 'public' ? 90 : 14) * DAY;
      const removed = await withMutation(() =>
        db.transaction(async (tx) => {
          // Inbox admission can happen outside the turn lock. Serialize its brief
          // writes with the final eligibility check; never hold this across I/O.
          for (const table of tables)
            await tx.exec(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
          const conversation = await tx.get(
            'SELECT * FROM rove_conversation WHERE id=$1 FOR UPDATE',
            [candidate.id],
          );
          if (!conversation) return false;
          await tx.run(
            'UPDATE rove_conversation SET retention_checked_at=$1 WHERE id=$2',
            [now, candidate.id],
          );
          if (
            conversation.scope !== candidate.scope ||
            Number(conversation.last_activity_at) > cutoff ||
            (await hasUnfinishedRun(tx, candidate.id))
          )
            return false;
          for (const table of tables)
            if (
              await tx.get(
                `SELECT 1 FROM ${table} WHERE (conversation=$1 OR scope=$2) AND ${unfinishedJobs} LIMIT 1`,
                [candidate.id, candidate.scope],
              )
            )
              return false;
          signal.throwIfAborted();
          if (conversation.expired_at !== null) {
            if (visibility !== 'public' && !conversation.title_redacted)
              await tx.run(
                "UPDATE rove_conversation SET title='Expired conversation',title_redacted=TRUE,updated_at=GREATEST(updated_at+1,$1) WHERE id=$2",
                [now, candidate.id],
              );
            return false;
          }
          await tx.run(
            "UPDATE rove_exchange SET prompt='',reply='',expired=TRUE WHERE conversation_id=$1 AND NOT expired",
            [candidate.id],
          );
          // Keep request IDs permanently reserved without retaining copied prompts,
          // history, arguments, tool output, or approval detail. AIPs live separately.
          await tx.run(
            `UPDATE rove_run SET expired=TRUE,data=jsonb_build_object(
            'id',id,'conversation',conversation,'scope',scope,'status','done',
            'prompt','','history','[]'::jsonb,'steps',0,'expired',true)::text
           WHERE conversation=$1 AND status='done' AND NOT expired`,
            [candidate.id],
          );
          // Installed-channel terminal jobs are compacted at their own boundary;
          // scanning their permanent event receipts here would grow with lifetime use.
          if (tables.includes('rove_slack_job'))
            await tx.run(
              `UPDATE rove_slack_job SET content='',reply=''
               WHERE (conversation=$1 OR scope=$2) AND NOT (${unfinishedJobs})`,
              [candidate.id, candidate.scope],
            );
          await tx.run(
            `UPDATE rove_conversation SET expired_at=$1,title_redacted=$2,
           title=CASE WHEN $2 THEN 'Expired conversation' ELSE title END,
           updated_at=GREATEST(updated_at+1,$1) WHERE id=$3`,
            [now, visibility !== 'public', candidate.id],
          );
          return true;
        }),
      );
      checked++;
      if (removed) expired++;
    }
    return { checked, expired };
  };
}
