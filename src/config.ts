export interface Config {
  baseURL: string;
  authSecret: string;
  setupSecret?: string;
  databaseURL: string;
  redisURL: string;
  redisPrefix: string;
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
  function connection(name: string, protocols: string[]) {
    const value = env[name];
    try {
      if (value && protocols.includes(new URL(value).protocol)) return value;
    } catch {}
    throw new Error(
      `Set ${name} to a valid ${protocols.join(' or ')} connection URL.`,
    );
  }
  const databaseURL = connection('DATABASE_URL', ['postgres:', 'postgresql:']);
  const redisURL = connection('REDIS_URL', ['redis:', 'rediss:']);
  const redisPrefix = env.ROVE_STATE_KEY_PREFIX || 'rove';
  if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(redisPrefix))
    throw new Error(
      'ROVE_STATE_KEY_PREFIX must contain 1–100 letters, numbers, colons, underscores or hyphens.',
    );
  return {
    baseURL,
    authSecret,
    setupSecret,
    databaseURL,
    redisURL,
    redisPrefix,
  };
}
