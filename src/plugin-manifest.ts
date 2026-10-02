import { z } from 'zod';
import { HttpError } from './auth.js';
import { validateTool } from './mcp.js';
import { channelSpec } from './plugin-channel.js';

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

/** Public API v1: core-validated data. Downloaded source is never imported by the host. */
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
    channel: channelSpec.optional(),
    execution: z
      .object({
        runtime: z.literal('node'),
        source: z.string().min(1).max(32000),
      })
      .strict()
      .optional(),
    operations: z
      .array(
        z
          .object({
            id: pluginId,
            name,
            description: z.string().min(1).max(1000),
            inputSchema: z
              .object({ type: z.literal('object') })
              .catchall(z.unknown()),
            surfaces: z
              .array(z.enum(['tool', 'action', 'step']))
              .min(1)
              .max(3),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    pages: z
      .array(
        z
          .object({
            id: pluginId,
            title: name,
            content: z.string().max(8000),
            actions: z.array(pluginId).max(8).default([]),
          })
          .strict(),
      )
      .max(4)
      .default([]),
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
      pkg.operations.map((operation) => operation.id),
      pkg.pages.map((page) => page.id),
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
      if (
        !pkg.servers.some((server) => capability === `mcp:${server.id}`) &&
        !(
          pkg.channel &&
          ['channel:ingress', 'channel:delivery'].includes(capability)
        ) &&
        !(pkg.execution && capability === 'execute:offline')
      )
        fail('Unsupported capability.');
    }
    if (Boolean(pkg.execution) !== Boolean(pkg.operations.length))
      fail('Executable packages need source and declared operations together.');
    if (
      pkg.execution &&
      (pkg.category !== 'user' || !pkg.capabilities.includes('execute:offline'))
    )
      fail(
        'Executable operations require a User Plugin and an explicit execution grant.',
      );
    for (const operation of pkg.operations) {
      if (new Set(operation.surfaces).size !== operation.surfaces.length)
        fail('Operation surfaces must be unique.');
      try {
        validateTool({
          name: operation.id,
          description: operation.description,
          inputSchema: operation.inputSchema,
        });
      } catch {
        fail(
          'Operation input schema is unsupported or exceeds the supported limits.',
        );
      }
    }
    for (const page of pkg.pages)
      if (
        page.actions.some(
          (id) =>
            !pkg.operations.some(
              (operation) =>
                operation.id === id && operation.surfaces.includes('action'),
            ),
        )
      )
        fail('Page actions must reference declared dashboard operations.');
    if (pkg.channel) {
      if (pkg.category !== 'channel')
        fail('Channel configuration requires a Channel Plugin.');
      for (const capability of ['channel:ingress', 'channel:delivery'])
        if (!pkg.capabilities.includes(capability))
          fail('Declare each channel permission.');
      for (const key of [
        pkg.channel.signing.secret,
        pkg.channel.outgoing.secret,
      ])
        if (
          !pkg.secrets.some((secret) => secret.key === key && secret.required)
        )
          fail(
            'Channel signing and delivery credentials must be declared as required secrets.',
          );
    }
    if (pkg.category === 'channel' && !pkg.channel)
      fail('Declare a supported channel protocol.');
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
      'Unsupported plugin manifest. Use API v1, unique identifiers and supported contribution fields.',
    );
  return parsed.data;
}

export function compatibility(pkg: PluginPackage): string | null {
  if (pkg.pages.length)
    return 'Custom plugin pages are unavailable until their core renderer is implemented.';
  if (pkg.category === 'channel' && pkg.channel) return null;
  if (pkg.category !== 'agent')
    return 'Executable User Plugins require verified sandbox isolation. Activation is unavailable.';
  if (!pkg.skills.length && !pkg.instructions && !pkg.servers.length)
    return 'This package has no supported contributions.';
  return null;
}
