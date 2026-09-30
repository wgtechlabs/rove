import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { HttpError } from './auth.js';

export function createSecrets(secret: string) {
  // Preserve the existing model-key derivation so saved provider keys still open.
  const key = createHash('sha256')
    .update('rove:model-key:v1:')
    .update(secret)
    .digest();
  return {
    encrypt(value: string): string {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
        'base64',
      );
    },
    decrypt(value: string): string {
      try {
        const data = Buffer.from(value, 'base64');
        const cipher = createDecipheriv(
          'aes-256-gcm',
          key,
          data.subarray(0, 12),
        );
        cipher.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([
          cipher.update(data.subarray(28)),
          cipher.final(),
        ]).toString('utf8');
      } catch {
        throw new HttpError(
          503,
          'The saved credential cannot be opened. Save a new credential in settings.',
        );
      }
    },
  };
}
