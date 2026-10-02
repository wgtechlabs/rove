import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { type AgentTools, createAgent } from './agent.js';
import { HttpError, textField } from './auth.js';
import type { Config } from './config.js';
import {
  type Message,
  type ProviderSettings,
  providerURL,
} from './provider.js';
import { createSecrets } from './secrets.js';

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Only pre-dispatch contention may be retried by a durable channel inbox.
export class ChatBusyError extends HttpError {}

export function createChat(
  config: Config,
  tools: AgentTools = {
    instructions: () => '',
    tools: async () => [],
    execute: async () => '',
  },
) {
  const db = new DatabaseSync(config.databasePath);
  let agent: ReturnType<typeof createAgent>;
  try {
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS rove_model (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        base_url TEXT NOT NULL, model TEXT NOT NULL, system_prompt TEXT NOT NULL, api_key TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rove_conversation (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rove_exchange (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES rove_conversation(id),
        prompt TEXT NOT NULL, reply TEXT NOT NULL
      );`);
    if (
      !db
        .prepare('PRAGMA table_info(rove_conversation)')
        .all()
        .some((column) => column.name === 'scope')
    )
      db.exec(
        "ALTER TABLE rove_conversation ADD COLUMN scope TEXT NOT NULL DEFAULT 'web'",
      );
    agent = createAgent(config, tools);
  } catch (error) {
    db.close();
    throw error;
  }
  const { encrypt, decrypt } = createSecrets(config.authSecret);
  // ponytail: one in-flight reply per deployment; use a durable job queue before multiple replicas.
  let busy = false;
  let stopping = false;
  let active: AbortController | undefined;

  function saved() {
    return db.prepare('SELECT * FROM rove_model WHERE singleton = 1').get();
  }
  function settings() {
    const row = saved();
    return {
      baseURL: row ? String(row.base_url) : 'https://api.openai.com/v1',
      model: row ? String(row.model) : '',
      systemPrompt: row ? String(row.system_prompt) : '',
      configured: Boolean(row?.api_key),
    };
  }
  function saveSettings(body: Record<string, unknown>) {
    if (busy)
      throw new HttpError(
        409,
        'Wait for the current reply before changing model settings.',
      );
    const baseURL = providerURL(textField(body, 'baseURL', 1, 500).trim());
    const model = textField(body, 'model', 1, 100).trim();
    const systemPrompt = textField(body, 'systemPrompt', 0, 2000);
    const apiKey =
      body.apiKey === undefined
        ? ''
        : textField(body, 'apiKey', 0, 1000).trim();
    if (!model || /[\r\n]/.test(apiKey))
      throw new HttpError(400, 'Enter a model name and a valid API key.');
    const row = saved();
    if (!apiKey && (!row?.api_key || row.base_url !== baseURL))
      throw new HttpError(
        400,
        'Enter an API key for this provider. Changing the endpoint requires a new key.',
      );
    db.prepare(`INSERT INTO rove_model VALUES(1, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET base_url=excluded.base_url, model=excluded.model,
      system_prompt=excluded.system_prompt, api_key=excluded.api_key`).run(
      baseURL,
      model,
      systemPrompt,
      apiKey ? encrypt(apiKey) : String(row?.api_key),
    );
    return settings();
  }
  function disconnect() {
    if (busy)
      throw new HttpError(
        409,
        'Wait for the current reply before disconnecting.',
      );
    db.prepare("UPDATE rove_model SET api_key = '' WHERE singleton = 1").run();
    return settings();
  }
  function list(scope = 'web') {
    return db
      .prepare(
        'SELECT id, title, updated_at AS updatedAt FROM rove_conversation WHERE scope = ? ORDER BY updated_at DESC, id',
      )
      .all(scope);
  }
  function readMessages(id: string, exclude = new Set<string>()): Message[] {
    return db
      .prepare(
        'SELECT request_id, prompt, reply FROM rove_exchange WHERE conversation_id = ? ORDER BY sequence',
      )
      .all(id)
      .filter((item) => !exclude.has(String(item.request_id)))
      .flatMap((item) => [
        { role: 'user' as const, content: String(item.prompt) },
        { role: 'assistant' as const, content: String(item.reply) },
      ]);
  }
  function get(id: string, scope = 'web') {
    // Final model results are durable before presentation; repair a crash between the two writes.
    const owned = db
      .prepare('SELECT title FROM rove_conversation WHERE id=? AND scope=?')
      .get(id, scope);
    if (!owned) throw new HttpError(404, 'Conversation not found.');
    for (const run of agent.completed(id, `${scope}:${id}`)) {
      if (
        !db
          .prepare('SELECT 1 FROM rove_exchange WHERE request_id=?')
          .get(run.id)
      )
        persist(id, run.id, run.prompt, run.answer || '', {
          title: String(owned.title),
        });
    }
    const row = db
      .prepare(
        'SELECT id, title, updated_at AS updatedAt FROM rove_conversation WHERE id = ? AND scope = ?',
      )
      .get(id, scope);
    if (!row) throw new HttpError(404, 'Conversation not found.');
    const messages = readMessages(id);
    const pending = agent.pending(id, `${scope}:${id}`);
    return {
      ...(pending ? { pending } : {}),
      id: String(row.id),
      title: String(row.title),
      updatedAt: Number(row.updatedAt),
      messages: pending
        ? [...messages, { role: 'user' as const, content: pending.prompt }]
        : messages,
    };
  }
  function create(scope = 'web') {
    if (
      Number(
        db.prepare('SELECT COUNT(*) AS count FROM rove_conversation').get()
          ?.count,
      ) >= 200
    )
      throw new HttpError(
        409,
        'This preview supports up to 200 conversations.',
      );
    const id = randomUUID();
    db.prepare(
      'INSERT INTO rove_conversation(id,title,updated_at,scope) VALUES (?, ?, ?, ?)',
    ).run(id, 'New conversation', Date.now(), scope);
    return get(id, scope);
  }
  async function send(
    id: string,
    body: Record<string, unknown>,
    scope = 'web',
  ) {
    if (stopping)
      throw new ChatBusyError(
        503,
        'Rove is restarting. Retry your message in a moment.',
      );
    const content = textField(body, 'content', 1, 4000).trim();
    const requestId = textField(body, 'requestId', 36, 36);
    if (!content || !requestIdPattern.test(requestId))
      throw new HttpError(400, 'Send a message with a valid request ID.');
    const conversation = get(id, scope);
    const actionRequests = new Set(
      agent
        .completed(id, `${scope}:${id}`)
        .filter((run) => run.direct)
        .map((run) => run.id),
    );
    const previous = db
      .prepare(
        'SELECT conversation_id, prompt FROM rove_exchange WHERE request_id = ?',
      )
      .get(requestId);
    if (previous) {
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
    if (busy)
      throw new ChatBusyError(
        409,
        'Rove is already replying. Wait a moment and try again.',
      );
    if (conversation.messages.length >= 200)
      throw new HttpError(
        409,
        'This conversation has reached 100 replies. Start a new conversation.',
      );
    const row = saved();
    if (!row?.api_key)
      throw new HttpError(
        409,
        'Connect a model in settings before sending a message.',
      );
    const provider: ProviderSettings = {
      baseURL: String(row.base_url),
      model: String(row.model),
      systemPrompt: String(row.system_prompt),
      apiKey: decrypt(String(row.api_key)),
    };
    // Direct results remain visible in the UI, but are not model-authored conversation history.
    const history = readMessages(id, actionRequests).slice(-40);
    while (
      history.reduce(
        (total, message) => total + message.content.length,
        content.length,
      ) > 60000
    )
      history.splice(0, 2);
    history.push({ role: 'user', content });
    busy = true;
    active = new AbortController();
    try {
      const result = await agent.start(
        requestId,
        id,
        `${scope}:${id}`,
        content,
        history,
        provider,
        active.signal,
      );
      if (result.status !== 'done') return get(id, scope);
      const answer = result.answer || '';
      persist(id, requestId, content, answer, conversation);
      return get(id, scope);
    } finally {
      busy = false;
      active = undefined;
    }
  }
  async function requestAction(id: string, body: Record<string, unknown>) {
    if (busy || stopping)
      throw new ChatBusyError(
        409,
        'Rove is busy or restarting. Try again shortly.',
      );
    if (
      Object.keys(body).some(
        (key) => !['name', 'arguments', 'requestId', 'revision'].includes(key),
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
      throw new HttpError(400, 'Request an action with a valid request ID.');
    const conversation = get(id);
    const previous = db
      .prepare('SELECT 1 FROM rove_exchange WHERE request_id=?')
      .get(requestId);
    if (!previous && conversation.messages.length >= 200)
      throw new HttpError(
        409,
        'This conversation has reached 100 replies. Start a new conversation.',
      );
    busy = true;
    active = new AbortController();
    try {
      await agent.requestAction(
        requestId,
        id,
        `web:${id}`,
        name,
        body.arguments,
        active.signal,
        revision,
      );
      return get(id);
    } finally {
      busy = false;
      active = undefined;
    }
  }
  function persist(
    id: string,
    requestId: string,
    content: string,
    answer: string,
    conversation: { title: string },
  ) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'INSERT OR IGNORE INTO rove_exchange(request_id, conversation_id, prompt, reply) VALUES (?, ?, ?, ?)',
      ).run(requestId, id, content, answer);
      db.prepare(
        'UPDATE rove_conversation SET title = ?, updated_at = ? WHERE id = ?',
      ).run(
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM rove_exchange WHERE conversation_id=?',
          )
          .get(id)?.count !== 1
          ? conversation.title
          : content.slice(0, 80),
        Date.now(),
        id,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async function decide(
    id: string,
    body: Record<string, unknown>,
    scope = 'web',
  ) {
    if (busy || stopping)
      throw new ChatBusyError(
        409,
        'Rove is busy or restarting. Try again shortly.',
      );
    const conversation = get(id, scope);
    const approvalId = textField(body, 'approvalId', 36, 36);
    const decision = textField(body, 'decision', 1, 10);
    busy = true;
    active = new AbortController();
    try {
      const result = await agent.decide(
        id,
        `${scope}:${id}`,
        approvalId,
        decision,
        () => {
          const row = saved();
          if (!row?.api_key)
            throw new HttpError(409, 'Connect a model before continuing.');
          return {
            baseURL: String(row.base_url),
            model: String(row.model),
            systemPrompt: String(row.system_prompt),
            apiKey: decrypt(String(row.api_key)),
          };
        },
        active.signal,
      );
      if (result.status === 'done')
        persist(
          id,
          result.id,
          result.prompt,
          result.answer || '',
          conversation,
        );
      return get(id, scope);
    } finally {
      busy = false;
      active = undefined;
    }
  }
  return {
    settings,
    saveSettings,
    disconnect,
    list,
    get,
    create,
    send,
    requestAction,
    decide,
    cancelPending() {
      stopping = true;
      active?.abort();
    },
    close() {
      agent.close();
      db.close();
    },
  };
}
