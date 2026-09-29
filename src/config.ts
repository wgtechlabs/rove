export interface Config {
  baseURL: string;
  authSecret: string;
  setupSecret?: string;
  databasePath: string;
}

export function readConfig(env = process.env): Config {
  const baseURL = env.ROVE_URL;
  const setupSecret = env.ROVE_SETUP_SECRET;
  const authSecret = env.BETTER_AUTH_SECRET;
  if (!baseURL || !authSecret || authSecret.length < 32) {
    throw new Error(
      'Set ROVE_URL and a random BETTER_AUTH_SECRET of at least 32 characters.',
    );
  }
  const url = new URL(baseURL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.origin !== baseURL ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    throw new Error(
      'ROVE_URL must be an HTTPS origin (HTTP is allowed only on loopback).',
    );
  }
  if (setupSecret && (setupSecret.length < 32 || setupSecret === authSecret)) {
    throw new Error(
      'Use a separate random ROVE_SETUP_SECRET of at least 32 characters.',
    );
  }
  return {
    baseURL,
    authSecret,
    setupSecret,
    databasePath: env.ROVE_DATABASE_PATH || './data/rove.sqlite',
  };
}
