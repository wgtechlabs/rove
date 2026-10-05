import { randomUUID } from 'node:crypto';
import { type AgentTools, createAgent } from './agent.js';
import { HttpError, textField } from './auth.js';
import {
  createConversationRetention,
  type VisibilityResolver,
} from './conversation-retention.js';
import type { Sql } from './database.js';
import {
  type Message,
  type ProviderSettings,
  providerURL,
} from './provider.js';
import type { RuntimeConfig } from './runtime.js';
import {
  RuntimeBusyError as ChatBusyError,
  type TurnMetadata,
} from './runtime-state.js';
import { createSecrets } from './secrets.js';

export { RuntimeBusyError as ChatBusyError } from './runtime-state.js';

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function createChat(
  config: RuntimeConfig,
  tools: AgentTools = {
    instructions: () => '',
    tools: async () => [],
    execute: async () => '',
  },
) {
  const { db, state } = config;
  await state.assertOwned();
  await db.migrate(`
    CREATE TABLE IF NOT EXISTS rove_model (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      base_url TEXT NOT NULL, model TEXT NOT NULL, system_prompt TEXT NOT NULL, api_key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rove_conversation (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at BIGINT NOT NULL, scope TEXT NOT NULL DEFAULT 'web'
    );
    CREATE TABLE IF NOT EXISTS rove_exchange (
      sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES rove_conversation(id),
      prompt TEXT NOT NULL, reply TEXT NOT NULL
    );`);
  const agent = await createAgent(config, tools);
  const purgeTranscripts = await createConversationRetention(config);
  const { encrypt, decrypt } = createSecrets(config.authSecret);
  let stopping = false;
  let active: AbortController | undefined;
  const pending = new Set<Promise<unknown>>();
  const retentionControllers = new Set<AbortController>();

  async function work<T>(
    metadata: TurnMetadata,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (stopping)
      throw new ChatBusyError(
        503,
        'Rove is restarting. Retry your message in a moment.',
      );
    const running = state.withTurn(metadata, async (ownership) => {
      if (stopping)
        throw new ChatBusyError(
          503,
          'Rove is restarting. Retry your message in a moment.',
        );
      active = new AbortController();
      try {
        return await action(AbortSignal.any([ownership, active.signal]));
      } finally {
        active = undefined;
      }
    });
    pending.add(running);
    try {
      return await running;
    } finally {
      pending.delete(running);
    }
  }
  const saved = () => db.get('SELECT * FROM rove_model WHERE singleton=1');
  async function settings() {
    const row = await saved();
    return {
      baseURL: row ? String(row.base_url) : 'https://api.openai.com/v1',
      model: row ? String(row.model) : '',
      systemPrompt: row ? String(row.system_prompt) : '',
      configured: Boolean(row?.api_key),
    };
  }
  async function provider(): Promise<ProviderSettings> {
    const row = await saved();
    if (!row?.api_key)
      throw new HttpError(
        409,
        'Connect a model in settings before sending a message.',
      );
    return {
      baseURL: String(row.base_url),
      model: String(row.model),
      systemPrompt: String(row.system_prompt),
      apiKey: decrypt(String(row.api_key)),
    };
  }
  function saveSettings(body: Record<string, unknown>) {
    return work({ kind: 'settings' }, async () => {
      const baseURL = providerURL(textField(body, 'baseURL', 1, 500).trim());
      const model = textField(body, 'model', 1, 100).trim();
      const systemPrompt = textField(body, 'systemPrompt', 0, 2000);
      const apiKey =
        body.apiKey === undefined
          ? ''
          : textField(body, 'apiKey', 0, 1000).trim();
      if (!model || /[\r\n]/.test(apiKey))
        throw new HttpError(400, 'Enter a model name and a valid API key.');
      const row = await saved();
      if (!apiKey && (!row?.api_key || row.base_url !== baseURL))
        throw new HttpError(
          400,
          'Enter an API key for this provider. Changing the endpoint requires a new key.',
        );
      await state.assertOwned();
      await db.run(
        `INSERT INTO rove_model VALUES(1,$1,$2,$3,$4)
        ON CONFLICT(singleton) DO UPDATE SET base_url=excluded.base_url, model=excluded.model,
        system_prompt=excluded.system_prompt, api_key=excluded.api_key`,
        [
          baseURL,
          model,
          systemPrompt,
          apiKey ? encrypt(apiKey) : String(row?.api_key),
        ],
      );
      return settings();
    });
  }
  function disconnect() {
    return work({ kind: 'settings' }, async () => {
      await state.assertOwned();
      await db.run("UPDATE rove_model SET api_key='' WHERE singleton=1");
      return settings();
    });
  }
  async function listPage(
    scope = 'web',
    options: {
      state?: 'active' | 'archived' | 'all';
      limit?: number;
      cursor?: string;
    } = {},
  ) {
    const filter = options.state ?? 'active';
    const limit = options.limit ?? 50;
    if (
      !['active', 'archived', 'all'].includes(filter) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new HttpError(
        400,
        'Choose active, archived or all and a page size from 1 to 100.',
      );
    let after: { updatedAt: number; id: string } | undefined;
    if (options.cursor) {
      try {
        if (options.cursor.length > 1000) throw new Error('Invalid cursor');
        const value = JSON.parse(
          Buffer.from(options.cursor, 'base64url').toString(),
        );
        if (
          value.scope !== scope ||
          value.state !== filter ||
          !Number.isSafeInteger(value.updatedAt) ||
          typeof value.id !== 'string' ||
          value.id.length > 100
        )
          throw new Error('Invalid cursor');
        after = value;
      } catch {
        throw new HttpError(400, 'Invalid conversation page cursor.');
      }
    }
    const items = await db.all<{
      id: string;
      title: string;
      updatedAt: number;
      archivedAt: number | null;
      lastActivityAt: number;
      expiredAt: number | null;
    }>(
      `SELECT id,title,updated_at AS "updatedAt",archived_at AS "archivedAt",
       last_activity_at AS "lastActivityAt",expired_at AS "expiredAt"
       FROM rove_conversation WHERE scope=$1
       ${filter === 'active' ? 'AND archived_at IS NULL' : filter === 'archived' ? 'AND archived_at IS NOT NULL' : ''}
       ${after ? 'AND (updated_at < $3 OR (updated_at=$3 AND id > $4))' : ''}
       ORDER BY updated_at DESC,id LIMIT $2`,
      after
        ? [scope, limit + 1, after.updatedAt, after.id]
        : [scope, limit + 1],
    );
    const hasMore = items.length > limit;
    if (hasMore) items.pop();
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                scope,
                state: filter,
                updatedAt: last.updatedAt,
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  }
  async function list(scope = 'web') {
    return (await listPage(scope)).items;
  }
  async function archive(
    id: string,
    body: Record<string, unknown>,
    scope = 'web',
  ) {
    if (
      typeof body.archived !== 'boolean' ||
      !Number.isSafeInteger(body.expectedUpdatedAt) ||
      Object.keys(body).some(
        (key) => !['archived', 'expectedUpdatedAt'].includes(key),
      )
    )
      throw new HttpError(
        400,
        'Provide an archive choice and the current conversation timestamp.',
      );
    await state.assertOwned();
    const changed = await db.run(
      `UPDATE rove_conversation SET archived_at=CASE WHEN $1 THEN $2::bigint ELSE NULL END,
       updated_at=GREATEST(updated_at+1,$2) WHERE id=$3 AND scope=$4 AND updated_at=$5`,
      [body.archived, Date.now(), id, scope, body.expectedUpdatedAt],
    );
    if (!changed) {
      if (
        !(await db.get(
          'SELECT 1 FROM rove_conversation WHERE id=$1 AND scope=$2',
          [id, scope],
        ))
      )
        throw new HttpError(404, 'Conversation not found.');
      throw new HttpError(
        409,
        'This conversation changed. Reload it before changing its archive status.',
      );
    }
    return get(id, scope);
  }
  async function acceptInput(tx: Sql, id: string, restore = true) {
    await tx.run(
      `UPDATE rove_conversation SET archived_at=CASE WHEN $3 THEN NULL ELSE archived_at END,expired_at=NULL,title_redacted=FALSE,
       last_activity_at=$1,updated_at=GREATEST(updated_at+1,$1),retention_checked_at=0 WHERE id=$2`,
      [Date.now(), id, restore],
    );
  }
  async function readMessages(
    id: string,
    exclude = new Set<string>(),
  ): Promise<Message[]> {
    return (
      await db.all(
        'SELECT request_id,prompt,reply FROM rove_exchange WHERE conversation_id=$1 AND NOT expired ORDER BY sequence LIMIT 100',
        [id],
      )
    )
      .filter((item) => !exclude.has(String(item.request_id)))
      .flatMap((item) => [
        { role: 'user' as const, content: String(item.prompt) },
        { role: 'assistant' as const, content: String(item.reply) },
      ]);
  }
  async function persist(
    id: string,
    requestId: string,
    content: string,
    answer: string,
  ) {
    await state.assertOwned();
    await db.transaction(async (tx) => {
      const conversation = await tx.get(
        'SELECT title FROM rove_conversation WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!conversation) throw new HttpError(404, 'Conversation not found.');
      if (
        await tx.get('SELECT 1 FROM rove_run WHERE id=$1 AND expired', [
          requestId,
        ])
      )
        return;
      const inserted = await tx.run(
        `INSERT INTO rove_exchange(request_id,conversation_id,prompt,reply)
        VALUES($1,$2,$3,$4) ON CONFLICT(request_id) DO NOTHING`,
        [requestId, id, content, answer],
      );
      if (!inserted) return;
      const count = await tx.get(
        'SELECT COUNT(*) AS count FROM rove_exchange WHERE conversation_id=$1 AND NOT expired',
        [id],
      );
      await tx.run(
        'UPDATE rove_conversation SET title=$1,updated_at=GREATEST(updated_at+1,$2) WHERE id=$3',
        [
          Number(count?.count) === 1
            ? content.slice(0, 80)
            : conversation.title,
          Date.now(),
          id,
        ],
      );
    });
  }
  async function get(id: string, scope = 'web') {
    const owned = await db.get(
      'SELECT id FROM rove_conversation WHERE id=$1 AND scope=$2',
      [id, scope],
    );
    if (!owned) throw new HttpError(404, 'Conversation not found.');
    // Repair a crash after the durable model result but before its presentation.
    for (const run of await agent.completed(id, `${scope}:${id}`)) {
      if (
        !(await db.get('SELECT 1 FROM rove_exchange WHERE request_id=$1', [
          run.id,
        ]))
      )
        await persist(id, run.id, run.prompt, run.answer || '');
    }
    const row = await db.get(
      'SELECT id,title,updated_at AS "updatedAt",archived_at AS "archivedAt",last_activity_at AS "lastActivityAt",expired_at AS "expiredAt" FROM rove_conversation WHERE id=$1 AND scope=$2',
      [id, scope],
    );
    if (!row) throw new HttpError(404, 'Conversation not found.');
    const messages = await readMessages(id);
    const pending = await agent.pending(id, `${scope}:${id}`);
    return {
      ...(pending ? { pending } : {}),
      id: String(row.id),
      title: String(row.title),
      updatedAt: Number(row.updatedAt),
      archivedAt: row.archivedAt === null ? null : Number(row.archivedAt),
      lastActivityAt: Number(row.lastActivityAt),
      expiredAt: row.expiredAt === null ? null : Number(row.expiredAt),
      messages: pending
        ? [...messages, { role: 'user' as const, content: pending.prompt }]
        : messages,
    };
  }
  async function create(scope = 'web') {
    await state.assertOwned();
    const id = randomUUID();
    await db.run(
      'INSERT INTO rove_conversation(id,title,updated_at,scope,last_activity_at) VALUES($1,$2,$3,$4,$3)',
      [id, 'New conversation', Date.now(), scope],
    );
    return get(id, scope);
  }
  async function send(
    id: string,
    body: Record<string, unknown>,
    scope = 'web',
  ) {
    const content = textField(body, 'content', 1, 4000).trim();
    const requestId = textField(body, 'requestId', 36, 36);
    if (!content || !requestIdPattern.test(requestId))
      throw new HttpError(400, 'Send a message with a valid request ID.');
    return work(
      { kind: 'message', conversation: id, scope, requestId },
      async (signal) => {
        const conversation = await get(id, scope);
        const actionRequests = new Set(
          (await agent.completed(id, `${scope}:${id}`))
            .filter((run) => run.direct)
            .map((run) => run.id),
        );
        const previous = await db.get(
          'SELECT conversation_id,prompt,expired FROM rove_exchange WHERE request_id=$1',
          [requestId],
        );
        if (previous) {
          if (previous.expired)
            throw new HttpError(
              410,
              'This request has expired and cannot be replayed. Send a new message.',
            );
          if (
            previous.conversation_id !== id ||
            previous.prompt !== content ||
            actionRequests.has(requestId)
          )
            throw new HttpError(
              409,
              'This request ID was already used for another message.',
            );
          return conversation;
        }
        if (conversation.messages.length >= 200)
          throw new HttpError(
            409,
            'This conversation has reached 100 replies. Start a new conversation.',
          );
        const model = await provider();
        const history = (await readMessages(id, actionRequests)).slice(-40);
        while (
          history.reduce(
            (total, message) => total + message.content.length,
            content.length,
          ) > 60000
        )
          history.splice(0, 2);
        history.push({ role: 'user', content });
        const result = await agent.start(
          requestId,
          id,
          `${scope}:${id}`,
          content,
          history,
          model,
          signal,
          (tx) => acceptInput(tx, id),
        );
        if (result.status === 'done')
          await persist(id, requestId, content, result.answer || '');
        return get(id, scope);
      },
    );
  }
  function requestAction(id: string, body: Record<string, unknown>) {
    return work(
      { kind: 'action', conversation: id, scope: 'web' },
      async (signal) => {
        if (
          Object.keys(body).some(
            (key) =>
              !['name', 'arguments', 'requestId', 'revision'].includes(key),
          )
        )
          throw new HttpError(
            400,
            'Send only an action name, arguments, request ID and revision.',
          );
        const name = textField(body, 'name', 1, 160);
        const revision =
          body.revision === undefined
            ? undefined
            : textField(body, 'revision', 1, 256);
        const requestId = textField(body, 'requestId', 36, 36);
        if (!requestIdPattern.test(requestId))
          throw new HttpError(
            400,
            'Request an action with a valid request ID.',
          );
        const conversation = await get(id);
        const previous = await db.get(
          'SELECT 1 FROM rove_exchange WHERE request_id=$1',
          [requestId],
        );
        if (!previous && conversation.messages.length >= 200)
          throw new HttpError(
            409,
            'This conversation has reached 100 replies. Start a new conversation.',
          );
        await agent.requestAction(
          requestId,
          id,
          `web:${id}`,
          name,
          body.arguments,
          signal,
          revision,
          (tx) => acceptInput(tx, id),
        );
        return get(id);
      },
    );
  }
  function decide(id: string, body: Record<string, unknown>, scope = 'web') {
    return work(
      { kind: 'approval', conversation: id, scope },
      async (signal) => {
        await get(id, scope);
        const approvalId = textField(body, 'approvalId', 36, 36);
        const decision = textField(body, 'decision', 1, 10);
        const result = await agent.decide(
          id,
          `${scope}:${id}`,
          approvalId,
          decision,
          provider,
          signal,
          (tx) => acceptInput(tx, id, false),
        );
        if (result.status === 'done')
          await persist(id, result.id, result.prompt, result.answer || '');
        return get(id, scope);
      },
    );
  }
  function cancelPending() {
    stopping = true;
    active?.abort();
    for (const controller of retentionControllers) controller.abort();
  }
  return {
    settings,
    saveSettings,
    disconnect,
    list,
    listPage,
    archive,
    async purgeExpired(
      now = Date.now(),
      resolveVisibility?: VisibilityResolver,
    ) {
      if (stopping) throw new ChatBusyError(503, 'Rove is restarting.');
      const controller = new AbortController();
      retentionControllers.add(controller);
      const running = purgeTranscripts(
        now,
        resolveVisibility,
        AbortSignal.any([state.signal, controller.signal]),
        (action) => work({ kind: 'retention' }, action),
      );
      pending.add(running);
      try {
        return await running;
      } finally {
        retentionControllers.delete(controller);
        pending.delete(running);
      }
    },
    get,
    create,
    send,
    requestAction,
    decide,
    cancelPending,
    async close() {
      cancelPending();
      await Promise.allSettled(pending);
    },
  };
}
