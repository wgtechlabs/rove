import { HttpError } from './auth.js';
import type { RuntimeConfig } from './runtime.js';
import { createSlack } from './slack.js';

// Version 1 admits only core-bundled, provider-verified HTTP ingress. It does
// not load downloaded adapters or accept caller-supplied actors/scopes.
export const CHANNEL_API_VERSION = 1;

export async function createChannels(
  config: RuntimeConfig,
  chat: Parameters<typeof createSlack>[1],
) {
  let slack: Awaited<ReturnType<typeof createSlack>> | undefined;
  let initializing: Promise<void> | undefined;
  let retiring: Promise<void> | undefined;
  let failed = false;
  let stopping = false;
  let started = false;

  function status() {
    return {
      apiVersion: CHANNEL_API_VERSION,
      id: 'slack',
      bundled: true,
      state: stopping
        ? 'stopped'
        : failed
          ? 'failed'
          : slack
            ? 'ready'
            : 'stopped',
      message: failed
        ? 'Slack is unavailable. Check its configuration and save to retry. Web chat is still available.'
        : '',
    };
  }
  function fail() {
    failed = true;
    const previous = slack;
    slack = undefined;
    if (!previous) return;
    previous.cancelPending();
    retiring = previous
      .close()
      .catch(() => {
        console.error('Slack cleanup failed.');
      })
      .finally(() => {
        retiring = undefined;
      });
  }
  async function initialize() {
    if (stopping || retiring) return;
    if (initializing) return initializing;
    if (slack) return;
    initializing = (async () => {
      try {
        const next = await createSlack(config, chat, fail);
        if (stopping) {
          await next.close();
          return;
        }
        slack = next;
        await slack.settings();
        if (started) slack.start();
        failed = false;
      } catch {
        fail();
      }
    })();
    try {
      await initializing;
    } finally {
      initializing = undefined;
    }
  }
  function requireChannel(channel: string) {
    if (channel !== 'slack')
      throw new HttpError(404, 'This channel is not supported.');
  }
  function available() {
    if (!slack || stopping)
      throw new HttpError(503, 'Slack is temporarily unavailable.');
    return slack;
  }
  async function settings(channel = 'slack') {
    requireChannel(channel);
    try {
      if (slack) return { ...(await slack.settings()), health: status() };
    } catch {
      fail();
    }
    return {
      enabled: false,
      configured: false,
      allowedUsers: [],
      allowedChannels: [],
      adminUsers: [],
      allowDM: false,
      teamId: '',
      botUserId: '',
      failures: [],
      health: status(),
    };
  }
  await initialize();
  return {
    start() {
      started = true;
      slack?.start();
    },
    status,
    settings,
    async save(body: Record<string, unknown>, channel = 'slack') {
      requireChannel(channel);
      await retiring;
      await initialize();
      try {
        await available().save(body);
        return await settings(channel);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        fail();
        throw new HttpError(
          503,
          'Slack settings could not be saved. Try again.',
        );
      }
    },
    async retentionVisibility(
      scope: string,
      signal?: AbortSignal,
    ): Promise<'public' | 'private'> {
      return slack && !stopping
        ? slack.retentionVisibility(scope, signal)
        : 'private';
    },
    async handle(request: Request) {
      if (
        request.method !== 'POST' ||
        !['/api/slack/events', '/api/slack/interactivity'].includes(
          new URL(request.url).pathname,
        )
      )
        throw new HttpError(404, 'This channel route is not supported.');
      try {
        return await available().handle(request);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        fail();
        throw new HttpError(503, 'Slack is temporarily unavailable.');
      }
    },
    cancelPending() {
      stopping = true;
      slack?.cancelPending();
    },
    async close() {
      stopping = true;
      await initializing;
      const previous = slack;
      slack = undefined;
      await previous?.close().catch(() => {
        console.error('Slack cleanup failed.');
      });
      await retiring;
    },
  };
}
