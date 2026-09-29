import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError, textField } from './auth.js';
import type { Config } from './config.js';
import {
  type Message,
  type ProviderSettings,
  providerURL,
  reply,
} from './provider.js';

export function createChat(config: Config) {
  const db = new DatabaseSync(config.databasePath);
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
  } catch (error) {
    db.close();
    throw error;
  }
  const key = createHash('sha256')
    .update('rove:model-key:v1:')
    .update(config.authSecret)
    .digest();
  // ponytail: one in-flight reply per deployment; use a durable job queue before multiple replicas.
  let busy = false;
  let stopping = false;
  let active: AbortController | undefined;

  function encrypt(value: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
      'base64',
    );
  }
  function decrypt(value: string) {
    try {
      const data = Buffer.from(value, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString('utf8');
    } catch {
      throw new HttpError(
        503,
        'The saved API key cannot be opened. Save a new key in model settings.',
      );
    }
  }
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
  function list() {
    return db
      .prepare(
        'SELECT id, title, updated_at AS updatedAt FROM rove_conversation ORDER BY updated_at DESC, id',
      )
      .all();
  }
  function get(id: string) {
    const row = db
      .prepare(
        'SELECT id, title, updated_at AS updatedAt FROM rove_conversation WHERE id = ?',
      )
      .get(id);
    if (!row) throw new HttpError(404, 'Conversation not found.');
    const exchanges = db
      .prepare(
        'SELECT prompt, reply FROM rove_exchange WHERE conversation_id = ? ORDER BY sequence',
      )
      .all(id);
    const messages: Message[] = exchanges.flatMap((item) => [
      { role: 'user' as const, content: String(item.prompt) },
      { role: 'assistant' as const, content: String(item.reply) },
    ]);
    return {
      id: String(row.id),
      title: String(row.title),
      updatedAt: Number(row.updatedAt),
      messages,
    };
  }
  function create() {
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
    db.prepare('INSERT INTO rove_conversation VALUES (?, ?, ?)').run(
      id,
      'New conversation',
      Date.now(),
    );
    return get(id);
  }
  async function send(id: string, body: Record<string, unknown>) {
    if (stopping)
      throw new HttpError(
        503,
        'Rove is restarting. Retry your message in a moment.',
      );
    const content = textField(body, 'content', 1, 4000).trim();
    const requestId = textField(body, 'requestId', 36, 36);
    if (
      !content ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestId,
      )
    )
      throw new HttpError(400, 'Send a message with a valid request ID.');
    const conversation = get(id);
    const previous = db
      .prepare(
        'SELECT conversation_id, prompt FROM rove_exchange WHERE request_id = ?',
      )
      .get(requestId);
    if (previous) {
      if (previous.conversation_id !== id || previous.prompt !== content)
        throw new HttpError(
          409,
          'This request ID was already used for another message.',
        );
      return conversation;
    }
    if (busy)
      throw new HttpError(
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
    const history = conversation.messages.slice(-40);
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
      const answer = await reply(provider, history, active.signal);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          'INSERT INTO rove_exchange(request_id, conversation_id, prompt, reply) VALUES (?, ?, ?, ?)',
        ).run(requestId, id, content, answer);
        db.prepare(
          'UPDATE rove_conversation SET title = ?, updated_at = ? WHERE id = ?',
        ).run(
          conversation.messages.length
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
      return get(id);
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
    cancelPending() {
      stopping = true;
      active?.abort();
    },
    close: () => db.close(),
  };
}
