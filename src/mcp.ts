import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import {
  Client,
  fromJsonSchema,
  type JsonSchemaType,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { HttpError } from './auth.js';

const MAX_RESPONSE = 256_000;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix);
for (const [address, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const loopback = (host: string) =>
  ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

export function mcpURL(value: string, applicationURL: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'Enter a valid MCP endpoint URL.');
  }
  const local = new URL(applicationURL);
  const development = local.protocol === 'http:' && loopback(local.hostname);
  if (
    (url.protocol !== 'https:' &&
      !(development && url.protocol === 'http:' && loopback(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HttpError(
      400,
      'Use an HTTPS MCP endpoint without credentials, query or fragment. Local HTTP requires local development.',
    );
  return url.href;
}

// Resolve and pin each connection; a prior hostname check alone permits DNS rebinding.
async function destination(
  url: URL,
  localDevelopment: boolean,
  signal: AbortSignal,
) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<Awaited<ReturnType<typeof lookup>>[]>(
        (resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          lookup(hostname, { all: true })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
        },
      );
  if (
    !addresses.length ||
    addresses.some(({ address, family }) => {
      if (localDevelopment && loopback(hostname) && loopback(address))
        return false;
      return family === 4
        ? blocked.check(address)
        : !globalV6.check(address, 'ipv6') || blocked.check(address, 'ipv6');
    })
  )
    throw new HttpError(400, 'MCP endpoints must resolve to a public address.');
  const chosen = addresses[0];
  if (!chosen) throw new HttpError(400, 'The MCP endpoint has no address.');
  return chosen;
}

function boundedFetch(
  endpoint: URL,
  signal: AbortSignal,
  localDevelopment: boolean,
  fail: (error: unknown) => void,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.href !== endpoint.href)
      throw new HttpError(
        400,
        'MCP requests must use the configured endpoint.',
      );
    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
      ...(init?.signal ? [init.signal] : []),
    ]);
    combined.throwIfAborted();
    const address = await destination(url, localDevelopment, combined);
    combined.throwIfAborted();
    const headers = Object.fromEntries(new Headers(init?.headers));
    return new Promise<Response>((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const outgoing = send(
        url,
        {
          method: init?.method || 'GET',
          headers,
          signal: combined,
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (incoming) => {
          const status = incoming.statusCode || 502;
          if (status >= 300 && status < 400) {
            incoming.destroy();
            reject(new HttpError(502, 'MCP redirects are not allowed.'));
            return;
          }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined)
              responseHeaders.set(
                key,
                Array.isArray(value) ? value.join(', ') : value,
              );
          }
          if ([204, 205, 304].includes(status)) {
            incoming.resume();
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }
          let bytes = 0;
          const iterator = incoming[Symbol.asyncIterator]();
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { value, done } = await iterator.next();
                if (done) {
                  controller.close();
                  return;
                }
                bytes += value.length;
                if (bytes > MAX_RESPONSE)
                  throw new HttpError(502, 'The MCP response is too large.');
                controller.enqueue(new Uint8Array(value));
              } catch (error) {
                incoming.destroy();
                fail(error);
                controller.error(error);
              }
            },
            cancel() {
              incoming.destroy();
            },
          });
          resolve(new Response(body, { status, headers: responseHeaders }));
        },
      );
      outgoing.on('error', reject);
      if (init?.body != null && typeof init.body !== 'string') {
        outgoing.destroy();
        reject(new HttpError(400, 'Unsupported MCP request body.'));
        return;
      }
      outgoing.end(init?.body);
    });
  };
}

function inspectSchema(schema: unknown) {
  if (Buffer.byteLength(JSON.stringify(schema)) > 16_000)
    throw new HttpError(502, 'The MCP schema is too large.');
  let nodes = 0;
  function inspect(value: unknown, depth = 0) {
    if (++nodes > 512 || depth > 12)
      throw new HttpError(502, 'The MCP schema is too complex.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      // ponytail: reject patterns/references; isolate validation before supporting unbounded schema work.
      if (
        [
          'pattern',
          'patternProperties',
          '$ref',
          '$dynamicRef',
          '$recursiveRef',
        ].includes(key)
      )
        throw new HttpError(
          502,
          'This MCP schema uses unsupported references or patterns.',
        );
      inspect(child, depth + 1);
    }
  }
  inspect(schema);
}

function schemaValidator() {
  const validator = new AjvJsonSchemaValidator();
  return {
    getValidator<T>(schema: JsonSchemaType) {
      inspectSchema(schema);
      return validator.getValidator<T>(schema);
    },
  };
}

export function validateTool(tool: Tool) {
  if (
    !tool.name ||
    tool.name.length > 128 ||
    (tool.description?.length || 0) > 2000 ||
    Buffer.byteLength(JSON.stringify(tool)) > 16_000
  )
    throw new HttpError(
      502,
      'An MCP tool definition exceeds the supported limits.',
    );
  inspectSchema(tool.inputSchema);
  if (tool.outputSchema) inspectSchema(tool.outputSchema);
  try {
    return fromJsonSchema(
      tool.inputSchema as JsonSchemaType,
      schemaValidator(),
    );
  } catch {
    throw new HttpError(502, 'The MCP tool has an unsupported input schema.');
  }
}

export async function withMcp<T>(
  url: string,
  token: string,
  applicationURL: string,
  signal: AbortSignal,
  action: (
    client: Client,
    options: { signal: AbortSignal; timeout: number; maxTotalTimeout: number },
  ) => Promise<T>,
): Promise<T> {
  const endpoint = new URL(mcpURL(url, applicationURL));
  const local = new URL(applicationURL);
  const lifetime = new AbortController();
  const operation = AbortSignal.any([
    signal,
    lifetime.signal,
    AbortSignal.timeout(30_000),
  ]);
  let transportFailure: HttpError | undefined;
  function fail(error: unknown) {
    if (operation.aborted) return;
    transportFailure =
      error instanceof HttpError
        ? error
        : new HttpError(
            502,
            'The MCP server returned an invalid or interrupted response.',
          );
    lifetime.abort();
  }
  const client = new Client(
    { name: 'rove', version: '0.1.0' },
    {
      listMaxPages: 4,
      capabilities: {},
      jsonSchemaValidator: schemaValidator(),
    },
  );
  client.onerror = fail;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    ...(token ? { authProvider: { token: async () => token } } : {}),
    fetch: boundedFetch(
      endpoint,
      operation,
      local.protocol === 'http:' && loopback(local.hostname),
      fail,
    ),
    requestInit: { redirect: 'error' },
    onInsufficientScope: 'throw',
  });
  const options = {
    signal: operation,
    timeout: 15_000,
    maxTotalTimeout: 15_000,
  };
  try {
    await client.connect(transport, options);
    return await action(client, options);
  } catch (error) {
    if (transportFailure) throw transportFailure;
    if (error instanceof HttpError) throw error;
    if (signal.aborted || operation.aborted)
      throw new HttpError(
        503,
        'The MCP operation was stopped or timed out. Its remote outcome may be unknown.',
      );
    throw new HttpError(
      502,
      'The MCP server could not complete the request. Check its endpoint, credential and tool compatibility.',
    );
  } finally {
    const timeout = setTimeout(() => lifetime.abort(), 1000);
    try {
      await transport.terminateSession();
    } catch {
      /* Closing locally is required even if the remote session is unavailable. */
    } finally {
      clearTimeout(timeout);
      lifetime.abort();
      await client.close();
    }
  }
}
