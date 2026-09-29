import { z } from 'zod';
import { HttpError } from './auth.js';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}
export interface ProviderSettings {
  baseURL: string;
  model: string;
  systemPrompt: string;
  apiKey: string;
}

export function providerURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'Enter a valid model provider URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HttpError(
      400,
      'Use an HTTPS provider URL without credentials, query or fragment. HTTP is allowed only on loopback.',
    );
  }
  return url.href.replace(/\/+$/, '');
}

const completion = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().min(1).max(16000) }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
});

export async function reply(
  settings: ProviderSettings,
  history: Message[],
  signal: AbortSignal,
): Promise<string> {
  try {
    // Only the administrator controls this destination. Never follow redirects with credentials.
    const response = await fetch(`${settings.baseURL}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          {
            role: 'system',
            content:
              settings.systemPrompt ||
              'You are Rove, a helpful company assistant. Be clear about uncertainty. You have no connected tools and cannot take external actions.',
          },
          ...history,
        ],
        stream: false,
        max_completion_tokens: 2048,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new HttpError(
          502,
          'The model provider rejected the API key. Check model settings.',
        );
      if (response.status === 429)
        throw new HttpError(
          503,
          'The model provider is rate limited or out of credits. Check your provider account and try again.',
        );
      throw new HttpError(
        502,
        'The model provider could not answer. Check the endpoint, model and Chat Completions compatibility, then try again.',
      );
    }
    if (!response.body)
      throw new HttpError(
        502,
        'The model provider returned an empty response.',
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256_000)
          throw new HttpError(
            502,
            'The model response was too large. Try a shorter request.',
          );
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const parsed = completion.safeParse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    const choice = parsed.success ? parsed.data.choices[0] : undefined;
    if (!choice?.message.content.trim())
      throw new HttpError(
        502,
        'The model provider did not return a text answer. Check the model and try again.',
      );
    if (choice.finish_reason === 'length')
      throw new HttpError(
        502,
        'The model reached its response limit. Ask for a shorter answer or choose another model.',
      );
    return choice.message.content;
  } catch (error) {
    if (signal.aborted)
      throw new HttpError(
        503,
        'Rove is restarting. Retry your message in a moment.',
      );
    if (error instanceof HttpError) throw error;
    if (
      error instanceof Error &&
      ['TimeoutError', 'AbortError'].includes(error.name)
    )
      throw new HttpError(
        504,
        'The model took too long to respond. Try again.',
      );
    // Provider error payloads and URLs can contain credentials or private content.
    throw new HttpError(
      502,
      'Rove could not read a response from the model provider. Check model settings and try again.',
    );
  }
}
