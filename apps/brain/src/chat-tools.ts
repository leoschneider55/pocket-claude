/* eslint-disable @typescript-eslint/no-explicit-any */
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { MCP_SERVER_NAME, type Effort, type ModelInfo } from '@pocket/protocol';
import { z } from 'zod';

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** Used until a live Claude Code process reports its own list. */
export const FALLBACK_MODELS: ModelInfo[] = [
  { value: 'default', displayName: 'Default', description: 'Claude Code default for your plan' },
  { value: 'fable', displayName: 'Fable', description: 'Most capable for the hardest reasoning and long agentic work', efforts: [...EFFORTS] },
  { value: 'opus', displayName: 'Opus', description: 'Most capable for complex work', efforts: [...EFFORTS] },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Fast and capable for everyday tasks', efforts: [...EFFORTS] },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers', efforts: [...EFFORTS] },
];

/** Aliases the Claude Code CLI accepts even when its model list names them differently. */
const CLI_ALIASES = new Set(['fable', 'opus', 'sonnet', 'haiku', 'best', 'opusplan', 'fable[1m]', 'opus[1m]', 'sonnet[1m]']);

/** What the chat_* tools may see and change: the chat they are called from. */
export type Billing = 'api' | 'subscription';
export interface ChatPatch {
  model?: string | null;
  effort?: Effort | null;
  billing?: Billing;
}

export interface ChatControl {
  current(): { model?: string; effort?: Effort; billing: Billing };
  models(): Promise<ModelInfo[]>;
  /** Why this chat cannot bill the API, or null when it can. */
  apiBlocked(): string | null;
  /** Shown at once; the running Claude Code process takes it when the current turn ends. */
  configure(patch: ChatPatch): void;
}

export const CHAT_TOOL_NAMES = ['chat_models', 'chat_configure'] as const;
export const CHAT_ALLOWED_TOOLS = CHAT_TOOL_NAMES.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`);

/**
 * Finds the model the user named: a value or display name from the list, a unique prefix of one, a CLI alias or a
 * full `claude-…` id. `null` means back to the default; `undefined` means no such model.
 */
export function resolveModel(arg: string, models: readonly ModelInfo[]): string | null | undefined {
  const a = arg.trim().toLowerCase().replace(/^claude\s+/, '');
  if (!a) return undefined;
  if (a === 'default' || a === 'auto') return null;
  const named = models.filter((m) => m.value !== 'default');
  const exact = named.find((m) => m.value.toLowerCase() === a || m.displayName.toLowerCase() === a);
  if (exact) return exact.value;
  const unique = (list: ModelInfo[]) => (list.length === 1 ? list[0]!.value : undefined);
  const byPrefix = unique(named.filter((m) => m.value.toLowerCase().startsWith(a) || m.displayName.toLowerCase().startsWith(a)));
  if (byPrefix) return byPrefix;
  const byPart = unique(named.filter((m) => `${m.value} ${m.displayName}`.toLowerCase().includes(a)));
  if (byPart) return byPart;
  if (CLI_ALIASES.has(a) || /^claude-[a-z0-9.-]+(\[1m\])?$/.test(a)) return a;
  return undefined;
}

/** The asked level if the model has it, else the nearest lower one it has (or its lowest). */
export function fitEffort(effort: Effort, supported: readonly Effort[] | undefined): Effort {
  if (!supported?.length || supported.includes(effort)) return effort;
  const rank = (e: Effort) => EFFORTS.indexOf(e);
  const sorted = [...supported].sort((x, y) => rank(x) - rank(y));
  return sorted.filter((e) => rank(e) <= rank(effort)).pop() ?? sorted[0]!;
}

const modelName = (value: string | undefined, models: readonly ModelInfo[]) => {
  const v = value ?? 'default';
  const m = models.find((x) => x.value === v);
  return m ? `${m.displayName} (${m.value})` : v;
};
const effortName = (effort: Effort | undefined) => (effort ? EFFORT_LABEL[effort] : "Auto (the model's default)");
const billingName = (billing: Billing) => (billing === 'api' ? 'the Anthropic API key' : 'the Claude subscription');

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: 'text', text }] });
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });

const modelList = (models: readonly ModelInfo[]) =>
  models.map((m) => `- ${m.displayName} (${m.value}): ${m.description}${m.efforts?.length ? `. Thinking: ${m.efforts.join(', ')}` : ''}`).join('\n');

/** One line for the chat: "model → fable, thinking → max". */
export function describeChatChange(input: Record<string, unknown>): string {
  const parts = [
    typeof input.model === 'string' ? `model → ${input.model}` : '',
    typeof input.effort === 'string' ? `thinking → ${input.effort}` : '',
    input.billing === 'api' ? 'billing → API' : input.billing === 'subscription' ? 'billing → subscription' : '',
  ];
  return parts.filter(Boolean).join(', ') || 'no change';
}

/** What Claude is told about switching its own model, in every mode. */
export function chatToolsPrompt(): string {
  return [
    "# This chat's model",
    'The user may ask you, in the chat or on a call, to switch the model or how hard you think: "switch to Fable", "think at maximum", "use Sonnet with low effort".',
    "Do it with mcp__pocket__chat_configure (model and/or effort; max is the deepest thinking) and confirm in one short sentence; mcp__pocket__chat_models lists what is available. The phone shows the change at once and it applies from your next reply. Never change the model on your own initiative.",
    'The chat runs on the Claude subscription. "Switch to the API" / "переключи на API" means billing \'api\': the chat then bills the owner\'s Anthropic API key; "back to the subscription" is billing \'subscription\'. Switch billing only when asked.',
  ].join('\n');
}

export function chatTools(chat: () => ChatControl): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      'chat_models',
      'Show the model and thinking level this chat uses now and the models it can switch to, with their thinking (effort) levels.',
      {},
      async () => {
        const c = chat();
        const models = await c.models();
        const now = c.current();
        return ok(`Now: ${modelName(now.model, models)}, thinking ${effortName(now.effort)}, billed to ${billingName(now.billing)}.\nAvailable models:\n${modelList(models)}`);
      },
    ),
    tool(
      'chat_configure',
      "Switch this chat's model, thinking level and/or billing because the user asked for it, in the chat or on a call. \"Switch to Fable and think at maximum\" is model 'fable' with effort 'max'; \"switch to the API with Opus\" is billing 'api' with model 'opus'. The change shows on the phone at once and applies from the next reply.",
      {
        model: z.string().min(1).max(100).optional().describe("Model value or name, e.g. 'fable', 'opus', 'sonnet', 'haiku', a full claude-… id, or 'default' to go back to the default"),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']).optional().describe("How hard to think: low, medium, high, xhigh, max (deepest), or auto for the model's default"),
        billing: z.enum(['api', 'subscription']).optional().describe("Who pays: 'api' bills the owner's Anthropic API key, 'subscription' the Claude subscription"),
      },
      async ({ model, effort, billing }) => {
        if (model === undefined && effort === undefined && billing === undefined) return fail('Pass a model, an effort, billing, or a mix.');
        const c = chat();
        if (billing === 'api') {
          const blocked = c.apiBlocked();
          if (blocked) return fail(blocked);
        }
        const models = await c.models();
        const now = c.current();
        const patch: ChatPatch = {};
        if (billing !== undefined) patch.billing = billing;
        if (model !== undefined) {
          const value = resolveModel(model, models);
          if (value === undefined) return fail(`There is no model "${model}". Available:\n${modelList(models)}`);
          patch.model = value;
        }
        const notes: string[] = [];
        if (effort !== undefined) {
          if (effort === 'auto') patch.effort = null;
          else {
            const target = patch.model !== undefined ? (patch.model ?? 'default') : (now.model ?? 'default');
            const fitted = fitEffort(effort, models.find((m) => m.value === target)?.efforts);
            if (fitted !== effort) notes.push(`${modelName(target, models)} has no ${effort} thinking level, so it is set to its closest one: ${fitted}.`);
            patch.effort = fitted;
          }
        }
        c.configure(patch);
        const model_ = patch.model !== undefined ? (patch.model ?? undefined) : now.model;
        const effort_ = patch.effort !== undefined ? (patch.effort ?? undefined) : now.effort;
        const billing_ = patch.billing ?? now.billing;
        return ok([`Done: this chat now uses ${modelName(model_, models)} with thinking ${effortName(effort_)}, billed to ${billingName(billing_)}, from the next reply on.`, ...notes].join(' '));
      },
    ),
  ];
}
