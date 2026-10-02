import { createHash } from 'node:crypto';
import { HttpError } from './auth.js';
import { validateTool } from './mcp.js';
import type { PluginPackage } from './plugin-manifest.js';
import type { ToolDefinition } from './provider.js';

export interface PluginRuntime {
  status(): {
    configured: boolean;
    environmentId?: string | null;
    authType?: string | null;
  };
  execute(
    request: {
      source: string;
      operation: string;
      args: Record<string, unknown>;
      settings: Record<string, string | boolean>;
    },
    signal: AbortSignal,
  ): Promise<string>;
}

export function operationDefinition(
  installation: string,
  revision: string,
  operation: PluginPackage['operations'][number],
): ToolDefinition {
  return {
    name: `rove_plugin_${createHash('sha256').update(`${installation}:${operation.id}`).digest('hex').slice(0, 40)}`,
    label: operation.name,
    description: operation.description,
    parameters: operation.inputSchema,
    revision,
    surfaces: operation.surfaces,
  };
}

export async function checkOperationArguments(
  definition: ToolDefinition,
  args: Record<string, unknown>,
) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Buffer.byteLength(JSON.stringify(args)) > 16000
  )
    throw new HttpError(
      400,
      'Tool arguments must be a JSON object within 16 KB.',
    );
  const checked = await validateTool({
    name: definition.name,
    description: definition.description,
    inputSchema: { ...definition.parameters, type: 'object' },
  })['~standard'].validate(args);
  if (checked.issues)
    throw new HttpError(
      400,
      'The tool arguments do not match its input schema.',
    );
}
