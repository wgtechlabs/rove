import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HttpError } from './auth.js';
import {
  complete,
  type ProviderSettings,
  type ToolDefinition,
  type WireMessage,
} from './provider.js';
import type { RuntimeConfig } from './runtime.js';

export interface AgentTools {
  instructions(scope: string): string | Promise<string>;
  preview?(
    name: string,
    args: Record<string, unknown>,
    scope: string,
  ): string | Promise<string>;
  tools(scope: string, signal: AbortSignal): Promise<ToolDefinition[]>;
  execute(
    name: string,
    args: Record<string, unknown>,
    revision: string,
    scope: string,
    signal: AbortSignal,
  ): Promise<string>;
}
interface Run {
  id: string;
  conversation: string;
  scope: string;
  prompt: string;
  history: WireMessage[];
  status: 'waiting' | 'executing' | 'ready' | 'done';
  steps: number;
  answer?: string;
  direct?: true;
  pending?: {
    id: string;
    name: string;
    label?: string;
    arguments: Record<string, unknown>;
    revision: string;
    created: number;
    detail: string;
    description: string;
  };
}
export async function createAgent(config: RuntimeConfig, tools: AgentTools) {
  const { db, state } = config;
  await state.assertOwned();
  await db.migrate(`CREATE TABLE IF NOT EXISTS rove_run(
    sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    id TEXT PRIMARY KEY, conversation TEXT NOT NULL, scope TEXT NOT NULL, data TEXT NOT NULL
  )`);
  const read = async (id: string): Promise<Run | undefined> => {
    const row = await db.get('SELECT data FROM rove_run WHERE id=$1', [id]);
    return row ? JSON.parse(String(row.data)) : undefined;
  };
  async function save(run: Run, expected?: string) {
    await state.assertOwned();
    const data = JSON.stringify(run);
    const changed =
      expected === undefined
        ? await db.run(
            'INSERT INTO rove_run(id,conversation,scope,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
            [run.id, run.conversation, run.scope, data],
          )
        : await db.run('UPDATE rove_run SET data=$1 WHERE id=$2 AND data=$3', [
            data,
            run.id,
            expected,
          ]);
    if (!changed)
      throw new HttpError(
        409,
        'The saved action changed. Reload this conversation.',
      );
  }
  async function toolResult(run: Run, result: string) {
    const expected = JSON.stringify(run);
    if (run.direct) {
      run.answer = result.slice(0, 24000);
      run.status = 'done';
      await save(run, expected);
      return;
    }
    const last = run.history.at(-1);
    if (!last || !('tool_calls' in last) || !last.tool_calls[0])
      throw new HttpError(500, 'The saved action cannot be resumed.');
    run.history.push({
      role: 'tool',
      tool_call_id: last.tool_calls[0].id,
      content: result.slice(0, 24000),
    });
    run.status = 'ready';
    await save(run, expected);
  }
  for (const row of await db.all('SELECT data FROM rove_run', [])) {
    const run: Run = JSON.parse(String(row.data));
    if (run.status === 'executing')
      await toolResult(
        run,
        'Action outcome unknown after restart. Check the external system before proposing another action. This call will not be repeated.',
      );
  }
  async function active(conversation: string, scope: string) {
    for (const row of await db.all(
      'SELECT data FROM rove_run WHERE conversation=$1 AND scope=$2',
      [conversation, scope],
    )) {
      const run: Run = JSON.parse(String(row.data));
      if (run.status !== 'done') return run;
    }
    return undefined;
  }
  function view(run: Run) {
    return run.status === 'done' || !run.pending
      ? undefined
      : { ...run.pending, status: run.status, prompt: run.prompt };
  }
  async function advance(
    run: Run,
    provider: ProviderSettings,
    signal: AbortSignal,
    initial = false,
  ) {
    if (run.status === 'waiting' || run.status === 'done') return run;
    const available = (await tools.tools(run.scope, signal)).filter((tool) =>
      (tool.surfaces ?? ['tool']).some((surface) => surface !== 'action'),
    );
    const expected = JSON.stringify(run);
    const instructions = await tools.instructions(run.scope);
    await state.assertOwned();
    signal.throwIfAborted();
    const result = await complete(
      {
        ...provider,
        systemPrompt: [provider.systemPrompt, instructions]
          .filter(Boolean)
          .join('\n\n'),
      },
      run.history,
      signal,
      run.steps < 6 ? available : [],
    );
    if (result.call) {
      const definition = available.find(
        (tool) => tool.name === result.call.function.name,
      );
      let args: unknown;
      try {
        args = JSON.parse(result.call.function.arguments);
      } catch {
        throw new HttpError(502, 'The model supplied invalid tool arguments.');
      }
      if (
        !definition ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args)
      )
        throw new HttpError(502, 'The model supplied invalid tool arguments.');
      run.history.push({
        role: 'assistant',
        content: result.content,
        tool_calls: [result.call],
      });
      run.pending = {
        id: randomUUID(),
        name: definition.name,
        label: definition.label,
        arguments: args as Record<string, unknown>,
        revision: definition.revision,
        created: Date.now(),
        detail:
          (await tools.preview?.(
            definition.name,
            args as Record<string, unknown>,
            run.scope,
          )) || JSON.stringify(args, null, 2),
        description: definition.description,
      };
      run.steps++;
      run.status = 'waiting';
    } else {
      run.answer = result.content;
      run.status = 'done';
    }
    await save(run, initial ? undefined : expected);
    return run;
  }
  async function completed(
    conversation: string,
    scope: string,
  ): Promise<Run[]> {
    return (
      await db.all(
        'SELECT data FROM rove_run WHERE conversation=$1 AND scope=$2 ORDER BY sequence',
        [conversation, scope],
      )
    )
      .map((row) => JSON.parse(String(row.data)) as Run)
      .filter((run) => run.status === 'done');
  }
  return {
    completed,
    async requestAction(
      id: string,
      conversation: string,
      scope: string,
      name: string,
      args: unknown,
      signal: AbortSignal,
      expectedRevision?: string,
    ) {
      if (scope !== `web:${conversation}`)
        throw new HttpError(
          403,
          'Dashboard actions require a web conversation.',
        );
      let argumentsSnapshot: Record<string, unknown>;
      try {
        const serialized = JSON.stringify(args);
        const parsed: unknown = JSON.parse(serialized);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          Buffer.byteLength(serialized) > 16000
        )
          throw new Error('Invalid arguments.');
        argumentsSnapshot = parsed as Record<string, unknown>;
      } catch {
        throw new HttpError(
          400,
          'Action arguments must be a JSON object within 16 KB.',
        );
      }
      const previous = await read(id);
      if (previous) {
        if (
          !previous.direct ||
          previous.conversation !== conversation ||
          previous.scope !== scope ||
          previous.pending?.name !== name ||
          (expectedRevision !== undefined &&
            previous.pending.revision !== expectedRevision) ||
          !isDeepStrictEqual(previous.pending.arguments, argumentsSnapshot)
        )
          throw new HttpError(
            409,
            'This request ID was already used for another action or message.',
          );
        return previous;
      }
      if (await active(conversation, scope))
        throw new HttpError(
          409,
          'Review the pending action before requesting another action.',
        );
      const definition = (await tools.tools(scope, signal)).find(
        (tool) => tool.name === name && tool.surfaces?.includes('action'),
      );
      if (!definition)
        throw new HttpError(
          409,
          'This dashboard action is no longer available.',
        );
      if (
        expectedRevision !== undefined &&
        definition.revision !== expectedRevision
      )
        throw new HttpError(
          409,
          'This dashboard action changed. Reload its page before reviewing it.',
        );
      signal.throwIfAborted();
      const run: Run = {
        id,
        conversation,
        scope,
        prompt: `Run action: ${definition.label || definition.name}`,
        history: [],
        status: 'waiting',
        steps: 1,
        direct: true,
        pending: {
          id: randomUUID(),
          name: definition.name,
          label: definition.label,
          arguments: argumentsSnapshot,
          revision: definition.revision,
          created: Date.now(),
          detail:
            (await tools.preview?.(name, argumentsSnapshot, scope)) ||
            JSON.stringify(argumentsSnapshot, null, 2),
          description: definition.description,
        },
      };
      await save(run);
      return run;
    },
    async pending(conversation: string, scope: string) {
      const run = await active(conversation, scope);
      return run ? view(run) : undefined;
    },
    async start(
      id: string,
      conversation: string,
      scope: string,
      prompt: string,
      history: WireMessage[],
      provider: ProviderSettings,
      signal: AbortSignal,
    ) {
      const previous = await read(id);
      if (
        previous &&
        (previous.direct ||
          previous.conversation !== conversation ||
          previous.scope !== scope ||
          previous.prompt !== prompt)
      )
        throw new HttpError(
          409,
          'This request ID was already used for another message.',
        );
      const pending = await active(conversation, scope);
      if (pending && pending.id !== id)
        throw new HttpError(
          409,
          'Review the pending action before sending another message.',
        );
      const run = previous ?? {
        id,
        conversation,
        scope,
        prompt,
        history,
        status: 'ready' as const,
        steps: 0,
      };
      return advance(run, provider, signal, !previous);
    },
    async decide(
      conversation: string,
      scope: string,
      approvalId: string,
      decision: string,
      provider: () => Promise<ProviderSettings>,
      signal: AbortSignal,
    ) {
      const done = (await completed(conversation, scope)).find(
        (run) => run.pending?.id === approvalId,
      );
      if (done) {
        if (!done.direct) await provider();
        return done;
      }
      const run = await active(conversation, scope);
      if (!run || run.pending?.id !== approvalId)
        throw new HttpError(409, 'This approval is no longer pending.');
      const model = run.direct ? undefined : await provider();
      if (!['approve', 'deny'].includes(decision))
        throw new HttpError(400, 'Choose approve or deny.');
      if (run.status === 'executing')
        throw new HttpError(409, 'This action is already running.');
      if (run.status === 'waiting') {
        const pending = run.pending;
        if (decision === 'deny')
          await toolResult(
            run,
            'Administrator denied this action. Do not repeat it without a new explicit request.',
          );
        else {
          if (Date.now() - pending.created > 15 * 60_000)
            throw new HttpError(
              409,
              'Approval expired. Deny this action and request a new one.',
            );
          const available = await tools.tools(scope, signal);
          if (
            !available.some(
              (tool) =>
                tool.name === pending.name &&
                tool.revision === pending.revision &&
                (run.direct
                  ? tool.surfaces?.includes('action')
                  : (tool.surfaces ?? ['tool']).some(
                      (surface) => surface !== 'action',
                    )),
            )
          )
            throw new HttpError(
              409,
              'The tool or proposal changed. Deny this action and request a new one.',
            );
          const expected = JSON.stringify(run);
          run.status = 'executing';
          await save(run, expected); // Consume the approval before the first external side effect.
          let result: string;
          try {
            await state.assertOwned();
            signal.throwIfAborted();
            result = await tools.execute(
              pending.name,
              pending.arguments,
              pending.revision,
              scope,
              signal,
            );
          } catch (error) {
            result =
              error instanceof HttpError &&
              [400, 404, 409].includes(error.status)
                ? `${error.message} Check the recorded state before requesting another approval. This approved call will not be repeated.`
                : 'Action failed or its outcome could not be confirmed. Check the external system before trying again. This approved call will not be repeated.';
          }
          await toolResult(run, result);
        }
      }
      if (!model) return run;
      // A failed model continuation resumes from the saved result, never from the action.
      return advance(run, model, signal);
    },
  };
}
