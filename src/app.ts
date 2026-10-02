import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAips } from './aip.js';
import { createIdentity, HttpError } from './auth.js';
import { createChannels } from './channels.js';
import { createChat } from './chat.js';
import type { Config } from './config.js';
import { createExtensions } from './extensions.js';
import { createPluginChannels } from './plugin-channel.js';
import { createPlugins } from './plugins.js';
import { createRailwayRuntime } from './railway.js';

export const MAX_BODY = 32768;
// Plugin settings, secret bindings and channel allowlists can exceed the chat
// envelope, including JSON escaping. Keep the larger bound on this route only.
export function requestBodyLimit(path: string) {
  return path === '/api/admin/plugins/configure' ? 512 * 1024 : MAX_BODY;
}
const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/manage.js': ['manage.js', 'text/javascript; charset=utf-8'],
  '/plugins.js': ['plugins.js', 'text/javascript; charset=utf-8'],
  '/plugin-pages.js': ['plugin-pages.js', 'text/javascript; charset=utf-8'],
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
  const cleanup: (() => void | Promise<void>)[] = [() => identity.close()];
  let extensions: ReturnType<typeof createExtensions>;
  let aips: ReturnType<typeof createAips>;
  let chat: ReturnType<typeof createChat>;
  let slack: ReturnType<typeof createChannels>;
  let plugins: ReturnType<typeof createPlugins>;
  let runtime: ReturnType<typeof createRailwayRuntime>;
  let installedChannels: ReturnType<typeof createPluginChannels> | undefined;
  try {
    extensions = createExtensions(config);
    cleanup.push(() => extensions.close());
    runtime = createRailwayRuntime(config);
    cleanup.push(() => runtime.close());
    plugins = createPlugins(config, extensions, fetch, process.env, runtime);
    cleanup.push(() => plugins.close());
    void runtime
      .reconcile()
      .catch(() => console.error('Sandbox cleanup needs attention.'));
    aips = createAips(config, (skill) => plugins.activateRelease(skill));
    cleanup.push(() => aips.close());
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
        if (name.startsWith('rove_aip_'))
          return aips.preview(name, args, scope);
        if (name.startsWith('rove_plugin_')) return plugins.preview(name, args);
        return JSON.stringify(args, null, 2);
      },
      async tools(scope, signal) {
        const tools = [
          ...(await extensions.tools(signal)),
          ...(await plugins.tools(signal)),
        ];
        if (tools.length > 32)
          throw new HttpError(
            409,
            'Enable at most 32 MCP and plugin operations.',
          );
        return [...tools, ...aips.tools(scope)];
      },
      execute(name, args, revision, scope, signal) {
        if (name.startsWith('rove_aip_'))
          return aips.execute(name, args, revision, scope, signal);
        if (name.startsWith('rove_plugin_'))
          return plugins.execute(name, args, revision, signal);
        return extensions.execute(name, args, revision, signal);
      },
    });
    cleanup.push(() => chat.close());
    slack = createChannels(config, chat);
    cleanup.push(() => slack.close());
    slack.start();
    try {
      installedChannels = createPluginChannels(
        config,
        chat,
        plugins.activeChannel,
      );
      cleanup.push(() => installedChannels?.close());
      installedChannels.start();
    } catch {
      console.error('Installed channels are unavailable.');
    }
  } catch (error) {
    await Promise.allSettled(cleanup.reverse().map(async (close) => close()));
    throw error;
  }
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  async function route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const channelRoute = /^\/api\/channels\/([a-f0-9-]{36})\/events$/.exec(
      path,
    );
    if (request.method === 'POST' && channelRoute?.[1]) {
      if (!installedChannels)
        throw new HttpError(503, 'Installed channels are unavailable.');
      return installedChannels.handle(request, channelRoute[1]);
    }
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
        const releaseRoute =
          /^\/api\/admin\/plugins\/([a-f0-9-]{36})\/releases\/([a-f0-9]{64})$/.exec(
            path,
          );
        if (releaseRoute?.[1] && releaseRoute[2])
          return json(plugins.detail(releaseRoute[1], releaseRoute[2]));
        const channelStatus =
          /^\/api\/admin\/plugins\/([a-f0-9-]{36})\/channel$/.exec(path);
        if (channelStatus?.[1])
          return json(
            installedChannels?.status(channelStatus[1]) ?? {
              state: 'failed',
              jobs: [],
            },
          );
        if (path === '/api/admin/extensions') return json(extensions.list());
        if (path === '/api/admin/plugins') return json(plugins.list());
        if (path === '/api/admin/plugins/contributions')
          return json(plugins.contributions());
        if (path === '/api/admin/runtime') return json(runtime.status());
        if (path === '/api/admin/channels') return json(slack.status());
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
      if (Buffer.byteLength(raw) > requestBodyLimit(path))
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
      if (path === '/api/admin/plugins/sources')
        return json(plugins.saveSource(values));
      if (path === '/api/admin/plugins/install')
        return json(await plugins.install(values));
      if (path === '/api/admin/plugins/configure')
        return json(plugins.configure(values));
      if (path === '/api/admin/plugins/activate')
        return json(await plugins.activate(values));
      if (path === '/api/admin/plugins/deactivate')
        return json(plugins.deactivate(values));
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
      const actionRoute =
        /^\/api\/admin\/conversations\/([a-f0-9-]{36})\/actions$/.exec(path);
      if (actionRoute?.[1])
        return json(await chat.requestAction(actionRoute[1], values));
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
      installedChannels?.cancelPending();
      slack.cancelPending();
      chat.cancelPending();
    },
    async close() {
      installedChannels?.cancelPending();
      slack.cancelPending();
      chat.cancelPending();
      await installedChannels?.close().catch(() => {
        console.error('Installed channel cleanup failed.');
      });
      await slack.close();
      chat.close();
      aips.close();
      plugins.close();
      await runtime.close();
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
