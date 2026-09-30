import { createServer } from 'node:http';
import { createApplication, MAX_BODY } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const app = await createApplication(config);
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be between 1 and 65535.');
const server = createServer(async (incoming, outgoing) => {
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > MAX_BODY) {
        outgoing.writeHead(413, {
          Connection: 'close',
          'Content-Type': 'application/json',
        });
        outgoing.end(JSON.stringify({ message: 'The request is too large.' }));
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    // Never derive the public origin from untrusted Host or forwarded headers.
    const url =
      config.baseURL + (incoming.url?.startsWith('/') ? incoming.url : '/');
    const response = await app.fetch(
      new Request(url, {
        method: incoming.method,
        headers,
        ...(['GET', 'HEAD'].includes(incoming.method || 'GET')
          ? {}
          : { body: Buffer.concat(chunks) }),
      }),
    );
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => {
      if (name !== 'set-cookie') outgoing.setHeader(name, value);
    });
    if (response.headers.getSetCookie().length)
      outgoing.setHeader('set-cookie', response.headers.getSetCookie());
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end(
      JSON.stringify({ message: 'Something went wrong. Try again.' }),
    );
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, '0.0.0.0', () =>
  console.log(`Rove is listening on port ${port}.`),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.cancelPending();
    server.close(async () => {
      await app.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
