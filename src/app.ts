import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAips } from './aip.js';
import { createIdentity, HttpError } from './auth.js';
import { createChat } from './chat.js';
import type { Config } from './config.js';
import { createExtensions } from './extensions.js';
import { createSlack } from './slack.js';

export const MAX_BODY = 32768;
const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/manage.js': ['manage.js', 'text/javascript; charset=utf-8'],
  '/chat.js': ['chat.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/brand/icon.svg': ['brand/icon.svg', 'image/svg+xml'],
  '/fonts/fredoka-600-latin.woff2': [
    'fonts/fredoka-600-latin.woff2',
    'font/woff2',
  ],
  '/fonts/inter-latin.woff2': ['fonts/inter-latin.woff2', 'font/woff2'],
};

export async function createApplication(
  config: Config,
  publicPath = resolve('public'),
) {
  const identity = await createIdentity(config);
  const extensions = createExtensions(config);
  const aips = createAips(config, (skill) => {
    extensions.adoptSkill(skill);
  });
  let chat: ReturnType<typeof createChat>;
  try {
    chat = createChat(config, {
      instructions(scope) {
        return [
          extensions.instructions(),
          ...aips
            .list(scope)
            .slice(0, 10)
            .map(
              (aip) =>
                `Saved AIP: ${JSON.stringify({ id: aip.id, title: aip.title, status: aip.status, summary: aip.summary, skillName: aip.skillName, url: aip.url })}`,
            ),
        ]
          .filter(Boolean)
          .join('\n\n');
      },
      preview(name, args, scope) {
        return name.startsWith('rove_aip_')
          ? aips.preview(name, args, scope)
          : JSON.stringify(args, null, 2);
      },
      async tools(scope, signal) {
        return [...(await extensions.tools(signal)), ...aips.tools(scope)];
      },
      execute(name, args, revision, scope, signal) {
        return name.startsWith('rove_aip_')
          ? aips.execute(name, args, revision, scope, signal)
          : extensions.execute(name, args, revision, signal);
      },
    });
  } catch (error) {
    aips.close();
    extensions.close();
    identity.close();
    throw error;
  }
  const slack = createSlack(config, chat);
  slack.start();
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  async function route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
      request.method === 'POST' &&
      ['/api/slack/events', '/api/slack/interactivity'].includes(path)
    )
      return slack.handle(request);
    if (request.method === 'GET' && path === '/health')
      return json({ status: 'ok' });
    if (request.method === 'GET' && path === '/api/setup')
      return json({ required: !identity.hasAdmin() });
    if (path.startsWith('/api/admin/')) {
      const admin = await identity.requireAdmin(request);
      if (request.method === 'GET' && path === '/api/admin/me')
        return json(admin);
      if (request.method === 'GET') {
        if (path === '/api/admin/extensions') return json(extensions.list());
        if (path === '/api/admin/slack') return json(slack.settings());
        if (path === '/api/admin/github') return json(aips.settings());
        const aipRoute = /^\/api\/admin\/aips\/([a-f0-9-]{36})$/.exec(path);
        if (aipRoute?.[1]) {
          chat.get(aipRoute[1]);
          return json({ aips: aips.list(`web:${aipRoute[1]}`) });
        }
        if (path === '/api/admin/settings') return json(chat.settings());
        if (path === '/api/admin/conversations')
          return json({ conversations: chat.list() });
        const match = /^\/api\/admin\/conversations\/([a-f0-9-]{36})$/.exec(
          path,
        );
        if (match?.[1]) return json(chat.get(match[1]));
      }
    }
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== config.baseURL)
        throw new HttpError(
          403,
          'This request must come from Rove’s web interface.',
        );
      if (
        request.headers.get('content-type')?.split(';')[0]?.trim() !==
        'application/json'
      )
        throw new HttpError(415, 'Send JSON.');
      const raw = await request.text();
      if (Buffer.byteLength(raw) > MAX_BODY)
        throw new HttpError(413, 'The request is too large.');
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new HttpError(400, 'Send valid JSON.');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new HttpError(400, 'Send a JSON object.');
      const values = body as Record<string, unknown>;
      if (path === '/api/admin/extensions')
        return json(extensions.save(values));
      if (path === '/api/admin/extensions/probe') {
        if (typeof values.id !== 'string')
          throw new HttpError(400, 'Choose a connection.');
        return json(
          await extensions.probe(values.id, AbortSignal.timeout(20000)),
        );
      }
      if (path === '/api/admin/slack') return json(await slack.save(values));
      if (path === '/api/admin/github') return json(aips.saveSettings(values));
      const approvalRoute =
        /^\/api\/admin\/conversations\/([a-f0-9-]{36})\/approval$/.exec(path);
      if (approvalRoute?.[1])
        return json(await chat.decide(approvalRoute[1], values));
      if (path === '/api/admin/settings')
        return json(chat.saveSettings(body as Record<string, unknown>));
      if (path === '/api/admin/settings/disconnect')
        return json(chat.disconnect());
      if (path === '/api/admin/conversations') return json(chat.create(), 201);
      const messageRoute =
        /^\/api\/admin\/conversations\/([a-f0-9-]{36})\/messages$/.exec(path);
      if (messageRoute?.[1])
        return json(
          await chat.send(messageRoute[1], body as Record<string, unknown>),
        );
      if (
        path === '/api/setup' ||
        path === '/api/recover' ||
        path === '/api/auth/sign-in/email'
      )
        identity.limit(path);
      if (path === '/api/setup')
        return json(
          await identity.bootstrap(body as Record<string, unknown>),
          201,
        );
      if (path === '/api/recover')
        return json(await identity.recover(body as Record<string, unknown>));
      if (path === '/api/auth/sign-in/email' || path === '/api/auth/sign-out') {
        const authRequest = new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: raw,
        });
        return path === '/api/auth/sign-in/email'
          ? identity.signIn(authRequest)
          : identity.auth.handler(authRequest);
      }
    }
    // Expose only the auth routes this UI needs. Public signup and account mutation routes stay closed.
    if (request.method === 'GET' && path === '/api/auth/get-session')
      return identity.auth.handler(request);
    const asset = assets[path];
    if (request.method === 'GET' && asset) {
      return new Response(await readFile(resolve(publicPath, asset[0])), {
        headers: { 'Content-Type': asset[1] },
      });
    }
    throw new HttpError(404, 'Not found.');
  }
  return {
    cancelPending() {
      slack.cancelPending();
      chat.cancelPending();
    },
    async close() {
      slack.cancelPending();
      chat.cancelPending();
      await slack.close();
      chat.close();
      aips.close();
      extensions.close();
      identity.close();
    },
    async fetch(request: Request): Promise<Response> {
      let response: Response;
      try {
        response = await route(request);
      } catch (error) {
        if (error instanceof HttpError)
          response = json({ message: error.message }, error.status);
        else {
          // Do not log request bodies, passwords, cookies, recovery keys or database error payloads.
          console.error('Rove request failed.');
          response = json({ message: 'Something went wrong. Try again.' }, 500);
        }
      }
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'no-referrer');
      response.headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      );
      if (config.baseURL.startsWith('https:'))
        response.headers.set('Strict-Transport-Security', 'max-age=31536000');
      return response;
    },
  };
}
