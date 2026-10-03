import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { HttpError } from './auth.js';
import { ChatBusyError } from './chat.js';
import { resolvePublicDestination } from './mcp.js';
import type { RuntimeConfig } from './runtime.js';
import { createSecrets } from './secrets.js';
import type { createSlack } from './slack.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/);
const secretName = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(80);
const safeKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(
    (value) => !['constructor', 'prototype', '__proto__'].includes(value),
  );
const pointer = z
  .string()
  .min(2)
  .max(400)
  .regex(/^(?:\/(?:[^~/]|~[01])+){1,8}$/)
  .refine((value) =>
    value
      .split('/')
      .slice(1)
      .every(
        (part) =>
          !['__proto__', 'prototype', 'constructor'].includes(
            part.replace(/~1/g, '/').replace(/~0/g, '~'),
          ),
      ),
  );
const header = z
  .string()
  .regex(/^x-[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80);

/** A bounded declarative protocol, never executable plugin code. */
export const channelSpec = z
  .object({
    type: z.literal('hmac-json'),
    signing: z
      .object({
        secret: secretName,
        timestampHeader: header,
        signatureHeader: header,
      })
      .strict()
      .refine((value) => value.timestampHeader !== value.signatureHeader),
    incoming: z
      .object({
        eventId: pointer,
        tenant: pointer,
        actor: pointer,
        destination: pointer,
        thread: pointer,
        text: pointer,
        approvalId: pointer.optional(),
        decision: pointer.optional(),
      })
      .strict()
      .refine((value) => Boolean(value.approvalId) === Boolean(value.decision)),
    outgoing: z
      .object({
        url: z
          .string()
          .max(500)
          .refine((value) => {
            try {
              const url = new URL(value);
              return (
                url.protocol === 'https:' &&
                !url.username &&
                !url.password &&
                !url.search &&
                !url.hash
              );
            } catch {
              return false;
            }
          }),
        secret: secretName,
        fields: z
          .object({ destination: safeKey, thread: safeKey, text: safeKey })
          .strict()
          .refine((value) => new Set(Object.values(value)).size === 3),
      })
      .strict(),
  })
  .strict();

/** Only the dashboard may supply these access rules. They are not package fields. */
export const channelAccess = z
  .object({
    tenant: identifier,
    users: z.array(identifier).min(1).max(100),
    admins: z.array(identifier).max(100),
    destinations: z.array(identifier).min(1).max(100),
  })
  .strict()
  .refine((value) =>
    value.admins.every((admin) => value.users.includes(admin)),
  );

export interface ActiveChannel extends z.infer<typeof channelAccess> {
  revision: string;
  digest: string;
  spec: z.infer<typeof channelSpec>;
  secrets: Record<string, string>;
}

type Chat = Parameters<typeof createSlack>[1];
type Conversation = Awaited<ReturnType<Chat['get']>>;
type Decision = 'approve' | 'deny' | 'resume';
interface Job {
  id: string;
  installation: string;
  event: string;
  scope: string;
  actor: string;
  destination: string;
  thread: string;
  content: string;
  decision: Decision | '';
  approval: string;
  snapshot: string;
  fingerprint: string;
  conversation: string;
  reply: string;
  status: string;
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const MAX_CHANNEL_BODY = 65536;

function at(body: unknown, path: string | undefined) {
  if (!path) return undefined;
  let value = body;
  for (const segment of path.split('/').slice(1)) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function replyText(conversation: Conversation) {
  const pending = conversation.pending;
  if (!pending)
    return (
      conversation.messages
        .filter((message) => message.role === 'assistant')
        .at(-1)
        ?.content.slice(0, 16000) || 'Request processed.'
    );
  const detail = pending.detail ?? JSON.stringify(pending.arguments);
  if (pending.status === 'ready')
    return `Tool outcome saved. An authorized administrator can continue the reply using approval ${pending.id} and decision resume.`;
  if (detail.length > 24000)
    return `Tool request is too large to review here. An authorized administrator can deny approval ${pending.id}.`;
  return `Approval ${pending.id}\nTool: ${pending.label || pending.name}\n${pending.description || ''}\n${detail}\nAn authorized administrator may send approve or deny for this approval.`;
}

/** Owns verification, permissions, durable dispatch, credentials and delivery. */
export async function createPluginChannels(
  config: RuntimeConfig,
  chat: Chat,
  active: (installation: string) => Promise<ActiveChannel | undefined>,
) {
  const db = config.db;
  await config.state.assertOwned();
  await db.migrate(`
      CREATE TABLE IF NOT EXISTS rove_plugin_channel_thread(scope TEXT PRIMARY KEY, conversation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rove_plugin_channel_job(
        sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT UNIQUE NOT NULL,
        installation TEXT NOT NULL, event TEXT NOT NULL, scope TEXT NOT NULL, actor TEXT NOT NULL,
        destination TEXT NOT NULL, thread TEXT NOT NULL, content TEXT NOT NULL,
        decision TEXT NOT NULL, approval TEXT NOT NULL, snapshot TEXT NOT NULL, fingerprint TEXT NOT NULL,
        conversation TEXT NOT NULL DEFAULT '', reply TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        UNIQUE(installation,event));
      CREATE INDEX IF NOT EXISTS rove_plugin_channel_queue ON rove_plugin_channel_job(status,sequence);`);
  await config.state.assertOwned();
  await db.exec(`UPDATE rove_plugin_channel_job SET status='uncertain', snapshot='', content='', reply=''
    WHERE status IN ('processing','delivering');`);
  const secrets = createSecrets(config.authSecret);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let stopping = false;
  let failed = false;

  async function capture(id: string) {
    const value = await active(id);
    if (!value) return undefined;
    const spec = channelSpec.parse(value.spec);
    const access = channelAccess.parse({
      tenant: value.tenant,
      users: value.users,
      admins: value.admins,
      destinations: value.destinations,
    });
    const credentials: Record<string, string> = {};
    for (const key of [spec.signing.secret, spec.outgoing.secret]) {
      const credential = value.secrets[key];
      if (!credential || credential.length > 4000 || /[\r\n]/.test(credential))
        throw new HttpError(503, 'Channel credentials are unavailable.');
      credentials[key] = credential;
    }
    return {
      revision: value.revision,
      digest: value.digest,
      spec,
      ...access,
      secrets: credentials,
    } satisfies ActiveChannel;
  }
  async function current(job: Job) {
    const value = await capture(job.installation);
    return value && hash(JSON.stringify(value)) === job.fingerprint;
  }
  async function finish(job: Job, status: string) {
    await db.run(
      "UPDATE rove_plugin_channel_job SET status=$1, snapshot='', content='', reply='' WHERE id=$2",
      [status, job.id],
    );
  }
  async function handle(request: Request, installation: string) {
    if (stopping || failed)
      throw new HttpError(503, 'Installed channels are unavailable.');
    if (request.method !== 'POST')
      throw new HttpError(405, 'Use POST for channel events.');
    const state = await capture(installation);
    if (!state) throw new HttpError(404, 'Channel is not active.');
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get('content-type') || '',
      )
    )
      throw new HttpError(415, 'Send a signed JSON event.');
    const stamp = request.headers.get(state.spec.signing.timestampHeader) || '';
    const signature =
      request.headers.get(state.spec.signing.signatureHeader) || '';
    if (
      !/^\d{10}$/.test(stamp) ||
      Math.abs(Date.now() / 1000 - Number(stamp)) > 300 ||
      !/^v1=[a-f0-9]{64}$/.test(signature)
    )
      throw new HttpError(401, 'Invalid channel signature.');
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, 'Send a JSON event.');
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_CHANNEL_BODY) {
        await reader.cancel();
        throw new HttpError(413, 'Channel event exceeds 64 KB.');
      }
      parts.push(part.value);
    }
    const raw = Buffer.concat(parts);
    const expected = createHmac(
      'sha256',
      state.secrets[state.spec.signing.secret] || '',
    )
      .update(`v1:${stamp}:`)
      .update(raw)
      .digest();
    if (!timingSafeEqual(Buffer.from(signature.slice(3), 'hex'), expected))
      throw new HttpError(401, 'Invalid channel signature.');
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Send a JSON event.');
    }
    const bindings = state.spec.incoming;
    const fields = Object.fromEntries(
      ['eventId', 'tenant', 'actor', 'destination', 'thread'].map((key) => [
        key,
        at(body, bindings[key as keyof typeof bindings]),
      ]),
    );
    const parsed = z
      .object({
        eventId: identifier,
        tenant: identifier,
        actor: identifier,
        destination: identifier,
        thread: identifier,
      })
      .safeParse(fields);
    if (!parsed.success)
      throw new HttpError(
        400,
        'Channel identity bindings must contain valid identifiers.',
      );
    const event = parsed.data;
    if (
      event.tenant !== state.tenant ||
      !state.users.includes(event.actor) ||
      !state.destinations.includes(event.destination)
    )
      throw new HttpError(
        403,
        'This channel actor or destination is not authorized.',
      );
    const decision = at(body, bindings.decision);
    const approval = at(body, bindings.approvalId);
    const content = at(body, bindings.text);
    if (decision !== undefined || approval !== undefined) {
      if (!state.admins.includes(event.actor))
        throw new HttpError(403, 'Channel administrator approval is required.');
      if (
        typeof decision !== 'string' ||
        !['approve', 'deny', 'resume'].includes(decision) ||
        typeof approval !== 'string' ||
        !z.uuid().safeParse(approval).success
      )
        throw new HttpError(400, 'Send a valid approval decision.');
    } else if (
      typeof content !== 'string' ||
      !content.trim() ||
      content.length > 4000
    ) {
      throw new HttpError(
        400,
        'Channel messages must contain 1 to 4,000 characters.',
      );
    }
    const fingerprint = hash(JSON.stringify(state));
    const latest = await capture(installation);
    if (stopping || !latest || hash(JSON.stringify(latest)) !== fingerprint)
      throw new HttpError(
        409,
        'Channel configuration changed. Retry the event.',
      );
    return db.transaction(async (tx) => {
      await tx.exec('LOCK TABLE rove_plugin_channel_job IN EXCLUSIVE MODE');
      if (
        await tx.get(
          'SELECT 1 FROM rove_plugin_channel_job WHERE installation=$1 AND event=$2',
          [installation, event.eventId],
        )
      )
        return new Response(null, { status: 200 });
      // ponytail: retain 10,000 event tombstones forever; archival needs an explicit provider retry horizon.
      if (
        Number(
          (
            await tx.get(
              'SELECT COUNT(*) AS count FROM rove_plugin_channel_job',
            )
          )?.count,
        ) >= 10000 ||
        Number(
          (
            await tx.get(
              "SELECT COUNT(*) AS count FROM rove_plugin_channel_job WHERE status IN ('pending','processing','ready','delivering')",
            )
          )?.count,
        ) >= 500
      )
        throw new HttpError(503, 'The channel inbox is full.');
      const scope = `plugin-channel:${installation}:${hash(JSON.stringify([state.tenant, event.destination, event.thread]))}`;
      await tx.run(
        'INSERT INTO rove_plugin_channel_job(id,installation,event,scope,actor,destination,thread,content,decision,approval,snapshot,fingerprint)\n      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          randomUUID(),
          installation,
          event.eventId,
          scope,
          event.actor,
          event.destination,
          event.thread,
          decision === undefined ? String(content).trim() : '',
          decision === undefined ? '' : String(decision),
          typeof approval === 'string' ? approval : '',
          secrets.encrypt(JSON.stringify(state)),
          fingerprint,
        ],
      );
      return new Response(null, { status: 202 });
    });
  }
  async function deliver(job: Job, state: ActiveChannel, signal: AbortSignal) {
    const url = new URL(state.spec.outgoing.url);
    const address = await resolvePublicDestination(url, false, signal);
    signal.throwIfAborted();
    if (!(await current(job))) {
      await finish(job, 'cancelled');
      return;
    }
    const fields = state.spec.outgoing.fields;
    const body = JSON.stringify({
      [fields.destination]: job.destination,
      [fields.thread]: job.thread,
      [fields.text]: job.reply,
    });
    await db.run(
      "UPDATE rove_plugin_channel_job SET status='delivering' WHERE id=$1",
      [job.id],
    );
    await config.state.assertOwned();
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpsRequest(
        url,
        {
          method: 'POST',
          signal,
          headers: {
            authorization: `Bearer ${state.secrets[state.spec.outgoing.secret]}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (incoming) => {
          const status = incoming.statusCode || 502;
          incoming.destroy();
          if (status >= 200 && status < 300) resolve();
          else reject(new Error('Channel delivery was not accepted.'));
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
    await finish(job, 'sent');
  }
  async function processJob() {
    if (stopping) return;
    await config.state.assertOwned();
    const job = await db.get<Job>(
      "SELECT * FROM rove_plugin_channel_job WHERE status IN ('pending','ready') ORDER BY sequence LIMIT 1",
    );
    if (!job || stopping) return;
    controller = new AbortController();
    try {
      if (!(await current(job))) {
        await finish(job, 'cancelled');
        return;
      }
      const state = JSON.parse(secrets.decrypt(job.snapshot)) as ActiveChannel;
      if (job.status === 'pending') {
        if (!job.conversation) {
          const existing = await db.get(
            'SELECT conversation FROM rove_plugin_channel_thread WHERE scope=$1',
            [job.scope],
          );
          if (job.decision && !existing) {
            await finish(job, 'cancelled');
            return;
          }
          job.conversation = existing
            ? String(existing.conversation)
            : (await chat.create(job.scope)).id;
          await db.run(
            'INSERT INTO rove_plugin_channel_thread VALUES($1,$2) ON CONFLICT DO NOTHING',
            [job.scope, job.conversation],
          );
          await db.run(
            'UPDATE rove_plugin_channel_job SET conversation=$1 WHERE id=$2',
            [job.conversation, job.id],
          );
        }
        if (job.decision) {
          const pending = (await chat.get(job.conversation, job.scope)).pending;
          if (
            !state.admins.includes(job.actor) ||
            pending?.id !== job.approval ||
            (job.decision === 'resume'
              ? pending.status !== 'ready'
              : pending.status !== 'waiting') ||
            (job.decision === 'approve' &&
              (pending.detail ?? JSON.stringify(pending.arguments)).length >
                24000)
          ) {
            await finish(job, 'cancelled');
            return;
          }
        }
        await db.run(
          "UPDATE rove_plugin_channel_job SET status='processing' WHERE id=$1",
          [job.id],
        );
        await config.state.assertOwned();
        if (stopping) return;
        if (!(await current(job))) {
          await finish(job, 'cancelled');
          return;
        }
        const conversation = job.decision
          ? await chat.decide(
              job.conversation,
              {
                approvalId: job.approval,
                decision: job.decision === 'resume' ? 'approve' : job.decision,
              },
              job.scope,
            )
          : await chat.send(
              job.conversation,
              { content: job.content, requestId: job.id },
              job.scope,
            );
        job.reply = replyText(conversation);
        await db.run(
          "UPDATE rove_plugin_channel_job SET status='ready', reply=$1 WHERE id=$2",
          [job.reply, job.id],
        );
      }
      if (stopping) return;
      await deliver(
        job,
        state,
        AbortSignal.any([
          controller.signal,
          config.state.signal,
          AbortSignal.timeout(10000),
        ]),
      );
    } catch (error) {
      config.state.signal.throwIfAborted();
      const phase = String(
        (
          await db.get(
            'SELECT status FROM rove_plugin_channel_job WHERE id=$1',
            [job.id],
          )
        )?.status,
      );
      if (phase === 'processing' && error instanceof ChatBusyError) {
        await db.run(
          "UPDATE rove_plugin_channel_job SET status='pending' WHERE id=$1",
          [job.id],
        );
        return;
      }
      if (phase === 'processing' && job.conversation) {
        const continuation = await chat.get(job.conversation, job.scope);
        if (continuation.pending?.status === 'ready') {
          await db.run(
            "UPDATE rove_plugin_channel_job SET status='ready', reply=$1 WHERE id=$2",
            [replyText(continuation), job.id],
          );
          return;
        }
      }
      await finish(
        job,
        ['processing', 'delivering'].includes(phase) ? 'uncertain' : 'failed',
      );
    } finally {
      controller = undefined;
    }
  }
  function cancelPending() {
    stopping = true;
    if (timer) clearInterval(timer);
    controller?.abort();
  }
  return {
    handle,
    async status(installation: string) {
      return {
        state: failed ? 'failed' : stopping ? 'stopped' : 'ready',
        jobs: await db.all(
          'SELECT status, COUNT(*) AS count FROM rove_plugin_channel_job WHERE installation=$1 GROUP BY status',
          [installation],
        ),
      };
    },
    start() {
      if (timer || stopping) return;
      timer = setInterval(() => {
        if (running || stopping) return;
        running = processJob()
          .catch(() => {
            failed = true;
            cancelPending();
            console.error('Installed channel processing failed.');
          })
          .finally(() => {
            running = undefined;
          });
      }, 100);
      timer.unref();
    },
    cancelPending,
    async close() {
      cancelPending();
      await running;
    },
  };
}
