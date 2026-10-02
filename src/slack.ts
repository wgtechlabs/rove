import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './auth.js';
import type { Sql } from './database.js';
import type { RuntimeConfig } from './runtime.js';
import { createSecrets } from './secrets.js';

interface Conversation {
  messages: { role: string; content: string }[];
  pending?: {
    id: string;
    name: string;
    label?: string;
    arguments: unknown;
    status: string;
    detail?: string;
    description?: string;
  };
}
interface Chat {
  create(scope?: string): Promise<{ id: string }>;
  get(id: string, scope?: string): Promise<Conversation>;
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
export const MAX_SLACK_BODY = 262144;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const slackId = (value: string) => /^[A-Z][A-Z0-9]{1,30}$/.test(value);
const timestamp = (value: string) => /^\d{1,20}\.\d{1,10}$/.test(value);

export async function createSlack(
  config: RuntimeConfig,
  chat: Chat,
  onFailure?: () => void,
) {
  const db = config.db;
  let nextCleanup = 0;
  await config.state.assertOwned();
  await db.migrate(`
    CREATE TABLE IF NOT EXISTS rove_slack_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rove_slack_thread (scope TEXT PRIMARY KEY, conversation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rove_slack_job (
      sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
      channel TEXT NOT NULL, thread TEXT NOT NULL, "user" TEXT NOT NULL, content TEXT NOT NULL,
      conversation TEXT NOT NULL DEFAULT '', "approvalId" TEXT NOT NULL DEFAULT '', decision TEXT NOT NULL DEFAULT '',
      reply TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_at BIGINT NOT NULL DEFAULT 0, finished_at BIGINT NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS rove_slack_job_queue ON rove_slack_job(scope,sequence) WHERE status IN ('pending','processing','ready','delivering');
    CREATE INDEX IF NOT EXISTS rove_slack_job_retention ON rove_slack_job(status,finished_at);`);
  await config.state.assertOwned();
  await db.exec(`UPDATE rove_slack_job SET status='pending' WHERE status='processing';
    UPDATE rove_slack_job SET status='uncertain' WHERE status='delivering';`);
  await prune();
  async function prune() {
    const now = Date.now();
    if (now < nextCleanup) return;
    // Keep seven days of retry IDs and button origins; active work is never pruned.
    await db.run(
      "UPDATE rove_slack_job SET finished_at=$1 WHERE finished_at=0 AND status IN ('sent','failed','uncertain','cancelled')",
      [now],
    );
    await db.exec(
      "UPDATE rove_slack_job SET content='', reply='' WHERE status='sent' AND (content<>'' OR reply<>'')",
    );
    await db.run(
      "DELETE FROM rove_slack_job WHERE status IN ('sent','failed','uncertain','cancelled') AND finished_at < $1",
      [now - 7 * 86400000],
    );
    nextCleanup = now + 60000;
  }
  const secrets = createSecrets(config.authSecret);
  let stopping = false;
  let saving = false;
  let saveDone: Promise<void> | undefined;
  let active: AbortController | undefined;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function saved(sql: Sql = db): Promise<Settings> {
    const row = await sql.get(
      'SELECT value FROM rove_slack_settings WHERE singleton=1',
    );
    return row ? (JSON.parse(String(row.value)) as Settings) : { ...empty };
  }
  async function settings() {
    const { botToken, signingSecret, ...visible } = await saved();
    const failures = await db.all(
      "SELECT status, COUNT(*) AS count FROM rove_slack_job WHERE status IN ('failed','uncertain') GROUP BY status",
    );
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
    await config.state.assertOwned();
    if (stopping) throw new HttpError(503, 'Rove is restarting.');
    const signal = AbortSignal.any([
      config.state.signal,
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
      if (bytes > MAX_SLACK_BODY) {
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
    saving = true;
    active = new AbortController();
    let finishSave!: () => void;
    saveDone = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    try {
      await config.state.assertOwned();
      const previous = await saved();
      const lists = ['allowedUsers', 'allowedChannels', 'adminUsers'] as const;
      if (
        typeof body.enabled !== 'boolean' ||
        typeof body.allowDM !== 'boolean'
      )
        throw new HttpError(
          400,
          'Choose whether Slack and direct messages are enabled.',
        );
      const next = {
        ...previous,
        enabled: body.enabled,
        allowDM: body.allowDM,
      };
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
      await config.state.assertOwned();
      await db.transaction(async (tx) => {
        await tx.exec('LOCK TABLE rove_slack_job IN EXCLUSIVE MODE');
        await tx.run(
          'INSERT INTO rove_slack_settings VALUES(1, $1) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value',
          [JSON.stringify(next)],
        );
        // Configuration changes revoke outstanding deliveries and approval buttons.
        await tx.run(
          "UPDATE rove_slack_job SET status='cancelled' WHERE status NOT IN ('failed','uncertain','cancelled')",
        );
      });
      return await settings();
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
    if (raw.length > MAX_SLACK_BODY)
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
  async function enqueue(
    job: Omit<
      Job,
      'conversation' | 'reply' | 'status' | 'attempts' | 'next_at'
    > & { conversation?: string },
    state: Settings,
  ) {
    await prune();
    await db.transaction(async (tx) => {
      await tx.exec('LOCK TABLE rove_slack_job IN EXCLUSIVE MODE');
      if (
        stopping ||
        saving ||
        JSON.stringify(await saved(tx)) !== JSON.stringify(state)
      )
        throw new HttpError(
          503,
          'Slack configuration changed. Retry the event.',
        );
      if (
        job.approvalId &&
        (await tx.get(
          "SELECT id FROM rove_slack_job WHERE \"approvalId\"=$1 AND status IN ('pending','processing','ready','delivering')",
          [job.approvalId],
        ))
      )
        return;
      if (await tx.get('SELECT id FROM rove_slack_job WHERE id=$1', [job.id]))
        return;
      if (
        Number(
          (
            await tx.get(
              "SELECT COUNT(*) AS n FROM rove_slack_job WHERE status IN ('pending','processing','ready','delivering')",
            )
          )?.n,
        ) >= 100
      )
        throw new HttpError(503, 'Slack queue is full. Retry later.');
      await tx.run(
        'INSERT INTO rove_slack_job(id,scope,channel,thread,"user",content,conversation,"approvalId",decision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          job.id,
          job.scope,
          job.channel,
          job.thread,
          job.user,
          job.content,
          job.conversation || '',
          job.approvalId,
          job.decision,
        ],
      );
    });
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
    const state = await saved();
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
      const origin = await db.get<Job>(
        "SELECT * FROM rove_slack_job WHERE id=$1 AND status='sent'",
        [string(value.job)],
      );
      if (
        !decision ||
        !origin ||
        origin.channel !== channel ||
        !origin.conversation ||
        !permitted(state, origin.user, channel)
      )
        return new Response(null, { status: 200 });
      const pending = (await chat.get(origin.conversation, origin.scope))
        .pending;
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
      await enqueue(
        {
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
        },
        state,
      );
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
      await enqueue(
        {
          id: string(body.event_id),
          scope: `slack:${state.teamId}:${channel}:${thread}`,
          channel,
          thread,
          user,
          content,
          approvalId: '',
          decision: '',
        },
        state,
      );
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
      ? `Approval required for ${pending.label || pending.name}.\n${pending.description || ''}\n${pending.detail ?? JSON.stringify(pending.arguments)}`
      : '';
    // Slack repeats message text in form-encoded interactions; reserve space for its envelope.
    const reviewable =
      approval.length <= 35000 &&
      encodeURIComponent(JSON.stringify(approval)).length * 2 + 32768 <=
        MAX_SLACK_BODY;
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
    await config.state.assertOwned();
    await prune();
    const job = await db.get<Job>(
      "SELECT job.* FROM rove_slack_job AS job\n        WHERE job.status IN ('pending','ready') AND job.next_at <= $1\n          AND NOT EXISTS (\n            SELECT 1 FROM rove_slack_job AS earlier\n            WHERE earlier.scope = job.scope AND earlier.sequence < job.sequence\n              AND earlier.status IN ('pending','processing','ready','delivering')\n          )\n        ORDER BY job.sequence LIMIT 1",
      [Date.now()],
    );
    if (!job) return;
    const state = await saved();
    if (stopping || saving) return;
    if (
      !permitted(state, job.user, job.channel) ||
      (job.decision && !state.adminUsers.includes(job.user))
    ) {
      await db.run("UPDATE rove_slack_job SET status='cancelled' WHERE id=$1", [
        job.id,
      ]);
      return;
    }
    active = new AbortController();
    try {
      if (job.status === 'pending') {
        await db.run(
          "UPDATE rove_slack_job SET status='processing' WHERE id=$1",
          [job.id],
        );
        if (!job.conversation) {
          const existing = await db.get(
            'SELECT conversation FROM rove_slack_thread WHERE scope=$1',
            [job.scope],
          );
          job.conversation = existing
            ? String(existing.conversation)
            : (await chat.create(job.scope)).id;
          await db.run(
            'INSERT INTO rove_slack_thread VALUES($1,$2) ON CONFLICT DO NOTHING',
            [job.scope, job.conversation],
          );
          await db.run(
            'UPDATE rove_slack_job SET conversation=$1 WHERE id=$2',
            [job.conversation, job.id],
          );
        }
        await config.state.assertOwned();
        if (stopping) return;
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
        await db.run(
          "UPDATE rove_slack_job SET status='ready', reply=$1 WHERE id=$2",
          [job.reply, job.id],
        );
      }
      if (stopping) return;
      await db.run(
        "UPDATE rove_slack_job SET status='delivering' WHERE id=$1",
        [job.id],
      );
      await api(
        'chat.postMessage',
        secrets.decrypt(state.botToken),
        JSON.parse(job.reply),
      );
      await db.run(
        "UPDATE rove_slack_job SET status='sent', content='', reply='', finished_at=$1 WHERE id=$2",
        [Date.now(), job.id],
      );
    } catch (error) {
      config.state.signal.throwIfAborted();
      const phase = String(
        (
          await db.get('SELECT status FROM rove_slack_job WHERE id=$1', [
            job.id,
          ])
        )?.status,
      );
      const continuation =
        phase === 'processing' && job.conversation
          ? await chat.get(job.conversation, job.scope)
          : undefined;
      if (!stopping && continuation?.pending?.status === 'ready') {
        await db.run(
          "UPDATE rove_slack_job SET status='ready', reply=$1 WHERE id=$2",
          [delivery(job, continuation), job.id],
        );
      } else if (error instanceof SlackRateLimit) {
        await db.run(
          "UPDATE rove_slack_job SET status='ready', next_at=$1 WHERE id=$2",
          [Date.now() + error.seconds * 1000, job.id],
        );
      } else if (phase === 'delivering') {
        await db.run('UPDATE rove_slack_job SET status=$1 WHERE id=$2', [
          error instanceof SlackRejected ? 'failed' : 'uncertain',
          job.id,
        ]);
      } else if (
        stopping ||
        (error instanceof HttpError &&
          (error.status === 409 || error.status === 503) &&
          job.attempts < 10)
      ) {
        await db.run(
          "UPDATE rove_slack_job SET status='pending', attempts=attempts+1, next_at=$1 WHERE id=$2",
          [Date.now() + 3000, job.id],
        );
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
        await db.run(
          "UPDATE rove_slack_job SET status='ready', reply=$1 WHERE id=$2",
          [reply, job.id],
        );
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
            cancelPending();
            onFailure?.();
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
