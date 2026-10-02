import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './auth.js';
import type { Config } from './config.js';
import {
  complete,
  type ProviderSettings,
  type ToolDefinition,
  type WireMessage,
} from './provider.js';

export interface AgentTools {
  instructions(scope: string): string;
  preview?(name: string, args: Record<string, unknown>, scope: string): string;
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
  pending?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    revision: string;
    created: number;
    detail: string;
    description: string;
  };
}
export function createAgent(config: Config, tools: AgentTools) {
  const db = new DatabaseSync(config.databasePath);
  try {
    db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS rove_run(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL);`);
  } catch (error) {
    db.close();
    throw error;
  }
  const read = (id: string): Run | undefined => {
    const row = db.prepare('SELECT data FROM rove_run WHERE id=?').get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  };
  function save(run: Run) {
    db.prepare(
      'INSERT INTO rove_run VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
    ).run(run.id, run.conversation, run.scope, JSON.stringify(run));
  }
  function toolResult(run: Run, result: string) {
    const last = run.history.at(-1);
    if (!last || !('tool_calls' in last) || !last.tool_calls[0])
      throw new HttpError(500, 'The saved action cannot be resumed.');
    run.history.push({
      role: 'tool',
      tool_call_id: last.tool_calls[0].id,
      content: result.slice(0, 24000),
    });
    run.status = 'ready';
    save(run);
  }
  // A process exit after dispatch cannot prove whether an external action succeeded.
  try {
    for (const row of db.prepare('SELECT data FROM rove_run').all()) {
      const run: Run = JSON.parse(String(row.data));
      if (run.status === 'executing')
        toolResult(
          run,
          'Action outcome unknown after restart. Check the external system before proposing another action. This call will not be repeated.',
        );
    }
  } catch (error) {
    db.close();
    throw error;
  }
  function active(conversation: string, scope: string) {
    for (const row of db
      .prepare('SELECT data FROM rove_run WHERE conversation=? AND scope=?')
      .all(conversation, scope)) {
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
  ) {
    if (run.status === 'waiting' || run.status === 'done') return run;
    const available = await tools.tools(run.scope, signal);
    const instructions = tools.instructions(run.scope);
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
        arguments: args as Record<string, unknown>,
        revision: definition.revision,
        created: Date.now(),
        detail:
          tools.preview?.(
            definition.name,
            args as Record<string, unknown>,
            run.scope,
          ) || JSON.stringify(args, null, 2),
        description: definition.description,
      };
      run.steps++;
      run.status = 'waiting';
    } else {
      run.answer = result.content;
      run.status = 'done';
    }
    save(run);
    return run;
  }
  function completed(conversation: string, scope: string): Run[] {
    return db
      .prepare(
        'SELECT data FROM rove_run WHERE conversation=? AND scope=? ORDER BY rowid',
      )
      .all(conversation, scope)
      .map((row) => JSON.parse(String(row.data)) as Run)
      .filter((run) => run.status === 'done');
  }
  return {
    completed,
    pending(conversation: string, scope: string) {
      const run = active(conversation, scope);
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
      const previous = read(id);
      if (
        previous &&
        (previous.conversation !== conversation ||
          previous.scope !== scope ||
          previous.prompt !== prompt)
      )
        throw new HttpError(
          409,
          'This request ID was already used for another message.',
        );
      const pending = active(conversation, scope);
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
      return advance(run, provider, signal);
    },
    async decide(
      conversation: string,
      scope: string,
      approvalId: string,
      decision: string,
      provider: ProviderSettings,
      signal: AbortSignal,
    ) {
      const done = completed(conversation, scope).find(
        (run) => run.pending?.id === approvalId,
      );
      if (done) return done;
      const run = active(conversation, scope);
      if (!run || run.pending?.id !== approvalId)
        throw new HttpError(409, 'This approval is no longer pending.');
      if (!['approve', 'deny'].includes(decision))
        throw new HttpError(400, 'Choose approve or deny.');
      if (run.status === 'executing')
        throw new HttpError(409, 'This action is already running.');
      if (run.status === 'waiting') {
        const pending = run.pending;
        if (decision === 'deny')
          toolResult(
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
                tool.revision === pending.revision,
            )
          )
            throw new HttpError(
              409,
              'The tool or proposal changed. Deny this action and request a new one.',
            );
          run.status = 'executing';
          save(run); // Consume the approval before the first external side effect.
          let result: string;
          try {
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
          toolResult(run, result);
        }
      }
      // A failed model continuation resumes from the saved result, never from the action.
      return advance(run, provider, signal);
    },
    close() {
      db.close();
    },
  };
}
