import { z } from 'zod';
import { HttpError } from './auth.js';

export const pluginId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(80);
export const repositoryName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1] ?? ''))
  .transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(80);
const setting = z
  .object({
    key: pluginId,
    label: name,
    type: z.enum(['text', 'boolean']),
    required: z.boolean().default(false),
    default: z.union([z.string().max(2000), z.boolean()]).optional(),
  })
  .strict()
  .refine(
    (field) =>
      field.default === undefined ||
      typeof field.default === (field.type === 'text' ? 'string' : 'boolean'),
  );

/** Public API v1: declarative data only. Unknown hooks are rejected, never imported. */
export const pluginPackage = z
  .object({
    schemaVersion: z.literal(1),
    apiVersion: z.literal(1),
    id: pluginId,
    name,
    version: z
      .string()
      .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
      .max(40),
    category: z.enum(['agent', 'user', 'channel']),
    description: z.string().max(500),
    skills: z
      .array(
        z
          .object({ name, markdown: z.string().trim().min(1).max(8000) })
          .strict(),
      )
      .max(8)
      .default([]),
    instructions: z.string().max(8000).default(''),
    servers: z
      .array(
        z
          .object({
            id: pluginId,
            name,
            url: z.string().min(1).max(500),
            secret: pluginId.optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    settings: z.array(setting).max(16).default([]),
    secrets: z
      .array(
        z
          .object({
            key: pluginId,
            label: name,
            required: z.boolean().default(false),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    capabilities: z.array(z.string().min(1).max(160)).max(16).default([]),
  })
  .strict()
  .superRefine((pkg, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const keys of [
      pkg.skills.map((x) => x.name),
      pkg.servers.map((x) => x.id),
      [...pkg.settings, ...pkg.secrets].map((x) => x.key),
      pkg.capabilities,
    ]) {
      if (new Set(keys).size !== keys.length)
        fail('Duplicate contribution identifiers.');
    }
    if (
      pkg.skills.reduce(
        (sum, item) => sum + item.markdown.length,
        pkg.instructions.length,
      ) > 24000
    )
      fail('Package instructions exceed 24,000 characters.');
    for (const server of pkg.servers) {
      if (!pkg.capabilities.includes(`mcp:${server.id}`))
        fail('Each MCP server needs a declared capability.');
      if (
        server.secret &&
        !pkg.secrets.some((item) => item.key === server.secret)
      )
        fail('MCP credential must reference a declared secret.');
    }
    for (const capability of pkg.capabilities) {
      if (!pkg.servers.some((server) => capability === `mcp:${server.id}`))
        fail('Unsupported capability. Executable plugins are not enabled.');
    }
    for (const content of [
      pkg.instructions,
      ...pkg.skills.map((item) => item.markdown),
    ]) {
      for (const match of content.matchAll(/\$\{settings\.([^}]+)\}/g)) {
        if (!pkg.settings.some((field) => field.key === match[1]))
          fail('Unknown setting reference.');
      }
    }
  });
export type PluginPackage = z.infer<typeof pluginPackage>;

export function parsePackage(value: unknown): PluginPackage {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 128000)
    throw new HttpError(400, 'Plugin artifact exceeds 128 KB.');
  const parsed = pluginPackage.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      400,
      'Unsupported plugin manifest. Use API v1, unique identifiers, and declarative skills or remote MCP only.',
    );
  return parsed.data;
}

export function compatibility(pkg: PluginPackage): string | null {
  if (pkg.category !== 'agent')
    return 'Executable User and Channel Plugins require verified sandbox isolation. Activation is unavailable.';
  if (!pkg.skills.length && !pkg.instructions && !pkg.servers.length)
    return 'This package has no supported contributions.';
  return null;
}
