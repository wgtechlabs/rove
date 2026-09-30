import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './auth.js';
import type { Config } from './config.js';
import { createSecrets } from './secrets.js';

interface Conversation {
  messages: { role: string; content: string }[];
  pending?: {
    id: string;
    name: string;
    arguments: unknown;
    status: string;
    detail?: string;
    description?: string;
  };
}
interface Chat {
  create(scope?: string): { id: string };
  get(id: string, scope?: string): Conversation;
  send(
    id: string,
    body: Record<string, unknown>,
    scope?: string,
  ): Promise<Conversation>;
  decide(
    id: string,
    body: { approvalId: string; decision: 'approve' | 'deny' },
    scope?: string,
  ): Promise<Conversation>;
}
interface Settings {
  enabled: boolean;
  botToken: string;
  signingSecret: string;
  allowedUsers: string[];
  allowedChannels: string[];
  adminUsers: string[];
  allowDM: boolean;
  teamId: string;
  botUserId: string;
}
interface Job {
  id: string;
  scope: string;
  channel: string;
  thread: string;
  user: string;
  content: string;
  conversation: string;
  approvalId: string;
  decision: 'approve' | 'deny' | '';
  reply: string;
  status: string;
  attempts: number;
  next_at: number;
}
const empty: Settings = {
  enabled: false,
  botToken: '',
  signingSecret: '',
  allowedUsers: [],
  allowedChannels: [],
  adminUsers: [],
  allowDM: false,
  teamId: '',
  botUserId: '',
};
const MAX_BODY = 262144;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const slackId = (value: string) => /^[A-Z][A-Z0-9]{1,30}$/.test(value);
const timestamp = (value: string) => /^\d{1,20}\.\d{1,10}$/.test(value);

export function createSlack(config: Config, chat: Chat) {
  const db = new DatabaseSync(config.databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS rove_slack_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rove_slack_thread (scope TEXT PRIMARY KEY, conversation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rove_slack_job (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
      channel TEXT NOT NULL, thread TEXT NOT NULL, user TEXT NOT NULL, content TEXT NOT NULL,
      conversation TEXT NOT NULL DEFAULT '', approvalId TEXT NOT NULL DEFAULT '', decision TEXT NOT NULL DEFAULT '',
      reply TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0);
    UPDATE rove_slack_job SET status='pending' WHERE status='processing';
    UPDATE rove_slack_job SET status='uncertain' WHERE status='delivering';`);
  const secrets = createSecrets(config.authSecret);
  let stopping = false;
  let saving = false;
  let saveDone: Promise<void> | undefined;
  let active: AbortController | undefined;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function saved(): Settings {
    const row = db
      .prepare('SELECT value FROM rove_slack_settings WHERE singleton=1')
      .get();
    return row ? (JSON.parse(String(row.value)) as Settings) : { ...empty };
  }
  function settings() {
    const { botToken, signingSecret, ...visible } = saved();
    const failures = db
      .prepare(
        "SELECT status, COUNT(*) AS count FROM rove_slack_job WHERE status IN ('failed','uncertain') GROUP BY status",
      )
      .all();
    return {
      ...visible,
      configured: Boolean(botToken && signingSecret),
      failures,
    };
  }
  function permitted(state: Settings, user: string, channel: string) {
    return (
      state.enabled &&
      state.allowedUsers.includes(user) &&
      (channel.startsWith('D')
        ? state.allowDM
        : state.allowedChannels.includes(channel))
    );
  }
  async function api(
    method: string,
    token: string,
    body: Record<string, unknown>,
  ) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(10000),
      ...(active ? [active.signal] : []),
    ]);
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    if (response.status === 429) {
      await response.body?.cancel();
      const retry = Number(response.headers.get('retry-after'));
      throw new SlackRateLimit(
        Number.isFinite(retry) ? Math.min(3600, Math.max(1, retry)) : 60,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Slack request failed.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Slack returned no response.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_BODY) {
        await reader.cancel();
        throw new Error('Slack response too large.');
      }
      chunks.push(part.value);
    }
    const result = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (result.ok !== true) throw new SlackRejected();
    return result;
  }
  async function save(body: Record<string, unknown>) {
    if (stopping || saving || running)
      throw new HttpError(409, 'Wait for Slack processing to finish.');
    const previous = saved();
    const lists = ['allowedUsers', 'allowedChannels', 'adminUsers'] as const;
    if (typeof body.enabled !== 'boolean' || typeof body.allowDM !== 'boolean')
      throw new HttpError(
        400,
        'Choose whether Slack and direct messages are enabled.',
      );
    const next = { ...previous, enabled: body.enabled, allowDM: body.allowDM };
    for (const field of lists) {
      const value = body[field];
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        value.some((item) => typeof item !== 'string' || !slackId(item))
      )
        throw new HttpError(
          400,
          'Enter up to 100 valid Slack IDs in each allowlist.',
        );
      next[field] = [...new Set(value as string[])];
    }
    if (next.adminUsers.some((user) => !next.allowedUsers.includes(user)))
      throw new HttpError(
        400,
        'Slack administrators must also be allowed users.',
      );
    for (const field of ['botToken', 'signingSecret'] as const) {
      if (body[field] !== undefined && typeof body[field] !== 'string')
        throw new HttpError(400, 'Enter valid Slack credentials.');
      const value = string(body[field]).trim();
      if (value.length > 1000 || /\s/.test(value))
        throw new HttpError(400, 'Enter valid Slack credentials.');
      if (value) next[field] = secrets.encrypt(value);
    }
    if (
      next.enabled &&
      (!next.botToken || !next.signingSecret || !next.allowedUsers.length)
    )
      throw new HttpError(
        400,
        'Add both Slack credentials and an allowed user before enabling Slack.',
      );
    saving = true;
    active = new AbortController();
    let finishSave!: () => void;
    saveDone = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    try {
      if (next.enabled) {
        const identity = await api(
          'auth.test',
          secrets.decrypt(next.botToken),
          {},
        );
        if (
          !slackId(string(identity.team_id)) ||
          !slackId(string(identity.user_id)) ||
          !identity.bot_id
        )
          throw new HttpError(400, 'Use an installed Slack bot token.');
        next.teamId = string(identity.team_id);
        next.botUserId = string(identity.user_id);
      }
      if (stopping) throw new HttpError(503, 'Rove is restarting.');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          'INSERT INTO rove_slack_settings VALUES(1, ?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value',
        ).run(JSON.stringify(next));
        // Configuration changes revoke outstanding deliveries and approval buttons.
        db.prepare(
          "UPDATE rove_slack_job SET status='cancelled' WHERE status NOT IN ('failed','uncertain','cancelled')",
        ).run();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return settings();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        'Slack could not verify the bot token. Check the credentials and try again.',
      );
    } finally {
      saving = false;
      active = undefined;
      finishSave();
      saveDone = undefined;
    }
  }
  async function verify(request: Request, state: Settings) {
    if (!state.signingSecret)
      throw new HttpError(503, 'Slack is not configured.');
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > MAX_BODY)
      throw new HttpError(413, 'The request is too large.');
    const stamp = request.headers.get('x-slack-request-timestamp') || '';
    const signature = request.headers.get('x-slack-signature') || '';
    if (
      !/^\d{1,12}$/.test(stamp) ||
      Math.abs(Date.now() / 1000 - Number(stamp)) > 300 ||
      !/^v0=[a-f0-9]{64}$/.test(signature)
    )
      throw new HttpError(401, 'Invalid Slack signature.');
    const expected = `v0=${createHmac('sha256', secrets.decrypt(state.signingSecret)).update(`v0:${stamp}:`).update(raw).digest('hex')}`;
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      throw new HttpError(401, 'Invalid Slack signature.');
    return raw.toString('utf8');
  }
  function enqueue(
    job: Omit<
      Job,
      'conversation' | 'reply' | 'status' | 'attempts' | 'next_at'
    > & { conversation?: string },
  ) {
    if (db.prepare('SELECT id FROM rove_slack_job WHERE id=?').get(job.id))
      return;
    if (
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM rove_slack_job WHERE status IN ('pending','processing','ready','delivering')",
          )
          .get()?.n,
      ) >= 100
    )
      throw new HttpError(503, 'Slack queue is full. Retry later.');
    db.prepare(
      'INSERT INTO rove_slack_job(id,scope,channel,thread,user,content,conversation,approvalId,decision) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      job.id,
      job.scope,
      job.channel,
      job.thread,
      job.user,
      job.content,
      job.conversation || '',
      job.approvalId,
      job.decision,
    );
  }
  async function handle(request: Request): Promise<Response> {
    if (stopping || saving)
      throw new HttpError(503, 'Slack is temporarily unavailable.');
    const path = new URL(request.url).pathname;
    if (
      request.method !== 'POST' ||
      !['/api/slack/events', '/api/slack/interactivity'].includes(path)
    )
      throw new HttpError(404, 'Not found.');
    const mime = request.headers.get('content-type')?.split(';')[0]?.trim();
    if (
      mime !==
      (path === '/api/slack/events'
        ? 'application/json'
        : 'application/x-www-form-urlencoded')
    )
      throw new HttpError(415, 'Invalid Slack content type.');
    const state = saved();
    const raw = await verify(request, state);
    let body: Record<string, unknown>;
    try {
      body = object(
        JSON.parse(
          path === '/api/slack/interactivity'
            ? new URLSearchParams(raw).get('payload') || ''
            : raw,
        ),
      );
    } catch {
      throw new HttpError(400, 'Invalid Slack payload.');
    }
    if (path === '/api/slack/events' && body.type === 'url_verification') {
      if (typeof body.challenge !== 'string' || body.challenge.length > 1000)
        throw new HttpError(400, 'Invalid Slack challenge.');
      return Response.json({ challenge: body.challenge });
    }
    if (!state.enabled) return new Response(null, { status: 200 });
    if (path === '/api/slack/interactivity') {
      const user = string(object(body.user).id);
      const channel = string(object(body.channel).id);
      if (
        body.type !== 'block_actions' ||
        object(body.team).id !== state.teamId ||
        !permitted(state, user, channel) ||
        !state.adminUsers.includes(user)
      )
        return new Response(null, { status: 200 });
      const action = object(
        Array.isArray(body.actions) ? body.actions[0] : undefined,
      );
      const decision =
        action.action_id === 'rove_approve' ||
        action.action_id === 'rove_resume'
          ? 'approve'
          : action.action_id === 'rove_deny'
            ? 'deny'
            : '';
      let value: Record<string, unknown>;
      try {
        value = object(JSON.parse(string(action.value)));
      } catch {
        return new Response(null, { status: 200 });
      }
      const origin = db
        .prepare("SELECT * FROM rove_slack_job WHERE id=? AND status='sent'")
        .get(string(value.job)) as unknown as Job | undefined;
      if (
        !decision ||
        !origin ||
        origin.channel !== channel ||
        !origin.conversation ||
        !permitted(state, origin.user, channel)
      )
        return new Response(null, { status: 200 });
      const pending = chat.get(origin.conversation, origin.scope).pending;
      if (
        !pending ||
        pending.id !== value.approval ||
        !(
          (pending.status === 'waiting' &&
            action.action_id !== 'rove_resume') ||
          (pending.status === 'ready' &&
            action.action_id === 'rove_resume' &&
            timestamp(string(action.action_ts)))
        )
      )
        return new Response(null, { status: 200 });
      enqueue({
        id:
          pending.status === 'ready'
            ? `resume:${pending.id}:${string(action.action_ts)}`
            : `approval:${pending.id}`,
        scope: origin.scope,
        channel,
        thread: origin.thread,
        user,
        content: '',
        conversation: origin.conversation,
        approvalId: pending.id,
        decision,
      });
    } else if (
      path === '/api/slack/events' &&
      body.type === 'event_callback' &&
      body.team_id === state.teamId &&
      body.is_ext_shared_channel !== true
    ) {
      const event = object(body.event);
      const user = string(event.user);
      const channel = string(event.channel);
      const thread = string(event.thread_ts || event.ts);
      const content = string(event.text)
        .replaceAll(`<@${state.botUserId}>`, '')
        .trim();
      if (
        !permitted(state, user, channel) ||
        user === state.botUserId ||
        event.bot_id ||
        event.subtype ||
        !slackId(channel) ||
        !timestamp(thread)
      )
        return new Response(null, { status: 200 });
      if (
        !(event.type === 'app_mention' && !channel.startsWith('D')) &&
        !(
          event.type === 'message' &&
          event.channel_type === 'im' &&
          channel.startsWith('D')
        )
      )
        return new Response(null, { status: 200 });
      if (
        !content ||
        content.length > 4000 ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(string(body.event_id))
      )
        return new Response(null, { status: 200 });
      enqueue({
        id: string(body.event_id),
        scope: `slack:${state.teamId}:${channel}:${thread}`,
        channel,
        thread,
        user,
        content,
        approvalId: '',
        decision: '',
      });
    }
    // The interval processes the durable inbox after this acknowledgement.
    return new Response(null, { status: 200 });
  }
  function delivery(job: Job, conversation: Conversation) {
    const answer =
      conversation.messages
        .filter((message) => message.role === 'assistant')
        .at(-1)?.content || 'Request processed.';
    const pending = conversation.pending;
    const approval = pending
      ? `Approval required for ${pending.name}.\n${pending.description || ''}\n${pending.detail ?? JSON.stringify(pending.arguments)}`
      : '';
    const reviewable = approval.length <= 35000;
    const text =
      pending?.status === 'ready'
        ? 'Rove saved the tool outcome but could not finish its reply. Continue the reply without running the tool again.'
        : pending?.status === 'waiting'
          ? reviewable
            ? approval
            : 'This tool request is too large to review safely in Slack. Deny it and ask for a smaller request.'
          : answer.slice(0, 12000);
    const body: Record<string, unknown> = {
      channel: job.channel,
      thread_ts: job.thread,
      text,
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
      reply_broadcast: false,
    };
    if (pending?.status === 'waiting' || pending?.status === 'ready')
      body.blocks = [
        ...Array.from(
          { length: Math.ceil(text.length / 2900) },
          (_, index) => ({
            type: 'section',
            text: {
              type: 'plain_text',
              text: text.slice(index * 2900, (index + 1) * 2900),
            },
          }),
        ),
        {
          type: 'actions',
          elements: (pending.status === 'ready'
            ? ['resume']
            : reviewable
              ? ['approve', 'deny']
              : ['deny']
          ).map((decision) => ({
            type: 'button',
            text: {
              type: 'plain_text',
              text:
                decision === 'resume'
                  ? 'Continue reply'
                  : decision === 'approve'
                    ? 'Approve once'
                    : 'Deny',
            },
            action_id: `rove_${decision}`,
            value: JSON.stringify({ job: job.id, approval: pending.id }),
          })),
        },
      ];
    return JSON.stringify(body);
  }
  async function processJob() {
    if (stopping || saving) return;
    const job = db
      .prepare(`SELECT job.* FROM rove_slack_job AS job
        WHERE job.status IN ('pending','ready') AND job.next_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM rove_slack_job AS earlier
            WHERE earlier.scope = job.scope AND earlier.sequence < job.sequence
              AND earlier.status IN ('pending','processing','ready','delivering')
          )
        ORDER BY job.sequence LIMIT 1`)
      .get(Date.now()) as unknown as Job | undefined;
    if (!job) return;
    const state = saved();
    if (
      !permitted(state, job.user, job.channel) ||
      (job.decision && !state.adminUsers.includes(job.user))
    ) {
      db.prepare("UPDATE rove_slack_job SET status='cancelled' WHERE id=?").run(
        job.id,
      );
      return;
    }
    active = new AbortController();
    try {
      if (job.status === 'pending') {
        db.prepare(
          "UPDATE rove_slack_job SET status='processing' WHERE id=?",
        ).run(job.id);
        if (!job.conversation) {
          const existing = db
            .prepare('SELECT conversation FROM rove_slack_thread WHERE scope=?')
            .get(job.scope);
          job.conversation = existing
            ? String(existing.conversation)
            : chat.create(job.scope).id;
          db.prepare('INSERT OR IGNORE INTO rove_slack_thread VALUES(?,?)').run(
            job.scope,
            job.conversation,
          );
          db.prepare('UPDATE rove_slack_job SET conversation=? WHERE id=?').run(
            job.conversation,
            job.id,
          );
        }
        const requestId = job.decision ? '' : requestUUID(job.id);
        const conversation = job.decision
          ? await chat.decide(
              job.conversation,
              { approvalId: job.approvalId, decision: job.decision },
              job.scope,
            )
          : await chat.send(
              job.conversation,
              { content: job.content, requestId },
              job.scope,
            );
        job.reply = delivery(job, conversation);
        db.prepare(
          "UPDATE rove_slack_job SET status='ready', reply=? WHERE id=?",
        ).run(job.reply, job.id);
      }
      if (stopping) return;
      db.prepare(
        "UPDATE rove_slack_job SET status='delivering' WHERE id=?",
      ).run(job.id);
      await api(
        'chat.postMessage',
        secrets.decrypt(state.botToken),
        JSON.parse(job.reply),
      );
      db.prepare("UPDATE rove_slack_job SET status='sent' WHERE id=?").run(
        job.id,
      );
    } catch (error) {
      const phase = String(
        db.prepare('SELECT status FROM rove_slack_job WHERE id=?').get(job.id)
          ?.status,
      );
      const continuation =
        phase === 'processing' && job.conversation
          ? chat.get(job.conversation, job.scope)
          : undefined;
      if (!stopping && continuation?.pending?.status === 'ready') {
        db.prepare(
          "UPDATE rove_slack_job SET status='ready', reply=? WHERE id=?",
        ).run(delivery(job, continuation), job.id);
      } else if (error instanceof SlackRateLimit) {
        db.prepare(
          "UPDATE rove_slack_job SET status='ready', next_at=? WHERE id=?",
        ).run(Date.now() + error.seconds * 1000, job.id);
      } else if (phase === 'delivering') {
        db.prepare('UPDATE rove_slack_job SET status=? WHERE id=?').run(
          error instanceof SlackRejected ? 'failed' : 'uncertain',
          job.id,
        );
      } else if (
        stopping ||
        (error instanceof HttpError &&
          (error.status === 409 || error.status === 503) &&
          job.attempts < 10)
      ) {
        db.prepare(
          "UPDATE rove_slack_job SET status='pending', attempts=attempts+1, next_at=? WHERE id=?",
        ).run(Date.now() + 3000, job.id);
      } else {
        const reply = delivery(job, {
          messages: [
            {
              role: 'assistant',
              content:
                'Rove could not finish this request. Check the web settings, then send a new message to retry.',
            },
          ],
        });
        db.prepare(
          "UPDATE rove_slack_job SET status='ready', reply=? WHERE id=?",
        ).run(reply, job.id);
      }
    } finally {
      active = undefined;
    }
  }
  function start() {
    if (timer || stopping) return;
    timer = setInterval(() => {
      if (!running && !stopping && !saving) {
        running = processJob()
          .catch(() => {
            console.error('Slack processing failed.');
          })
          .finally(() => {
            running = undefined;
          });
      }
    }, 250);
    timer.unref();
  }
  function cancelPending() {
    stopping = true;
    if (timer) clearInterval(timer);
    active?.abort();
  }
  return {
    settings,
    save,
    handle,
    start,
    cancelPending,
    async close() {
      cancelPending();
      await running;
      await saveDone;
      db.close();
    },
  };
}
class SlackRateLimit extends Error {
  constructor(readonly seconds: number) {
    super('Slack rate limited the request.');
  }
}
class SlackRejected extends Error {}
function requestUUID(id: string) {
  // Stable v4-shaped IDs keep core request deduplication valid across worker restarts.
  const bytes = createHmac('sha256', 'rove:slack-request:v1')
    .update(id)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
