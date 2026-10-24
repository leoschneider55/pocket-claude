import { describe, expect, it } from 'vitest';
import { CHAT_ALLOWED_TOOLS, chatTools, chatToolsPrompt, describeChatChange, FALLBACK_MODELS, fitEffort, resolveModel, type ChatControl, type ChatPatch } from '../src/chat-tools.js';
import type { Effort, ModelInfo } from '@pocket/protocol';

const MODELS: ModelInfo[] = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5' },
  { value: 'fable', displayName: 'Fable', description: 'Deepest', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', displayName: 'Opus', description: 'Capable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', displayName: 'Haiku', description: 'Fast', efforts: ['low', 'medium', 'high'] },
];

function control(now: { model?: string; effort?: Effort } = {}, models = MODELS, apiBlocked: string | null = null) {
  const patches: ChatPatch[] = [];
  const c: ChatControl = { current: () => ({ billing: 'subscription', ...now }), models: async () => models, apiBlocked: () => apiBlocked, configure: (p) => void patches.push(p) };
  const tools = Object.fromEntries(chatTools(() => c).map((t) => [t.name, t]));
  return { tools, patches };
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n');

describe('model names', () => {
  it('resolve by value, display name, prefix, alias or full id', () => {
    expect(resolveModel('fable', MODELS)).toBe('fable');
    expect(resolveModel('  Fable ', MODELS)).toBe('fable');
    expect(resolveModel('Claude Fable', MODELS)).toBe('fable');
    expect(resolveModel('fab', MODELS)).toBe('fable');
    expect(resolveModel('sonnet', MODELS)).toBe('sonnet');
    expect(resolveModel('claude-fable-5-1', MODELS)).toBe('claude-fable-5-1');
    expect(resolveModel('default', MODELS)).toBeNull();
    expect(resolveModel('gpt-5', MODELS)).toBeUndefined();
    expect(resolveModel('', MODELS)).toBeUndefined();
  });

  it('prefer the listed value when the CLI names a model by its full id', () => {
    const listed: ModelInfo[] = [{ value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' }];
    expect(resolveModel('fable', listed)).toBe('claude-fable-5-1');
  });

  it('fall back to the CLI alias when the name is ambiguous', () => {
    const two: ModelInfo[] = [
      { value: 'claude-fable-5', displayName: 'Fable 5', description: '' },
      { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' },
    ];
    expect(resolveModel('fable', two)).toBe('fable');
  });
});

describe('effort levels', () => {
  it('keep a supported level and step down to the nearest one otherwise', () => {
    expect(fitEffort('max', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max');
    expect(fitEffort('max', ['low', 'medium', 'high'])).toBe('high');
    expect(fitEffort('low', ['high', 'max'])).toBe('high');
    expect(fitEffort('xhigh', undefined)).toBe('xhigh');
  });
});

describe('chat tools', () => {
  it('are auto-allowed, explained in the prompt, and the fallback list has Fable', () => {
    expect(CHAT_ALLOWED_TOOLS).toEqual(['mcp__pocket__chat_models', 'mcp__pocket__chat_configure']);
    expect(chatToolsPrompt()).toMatch(/chat_configure/);
    expect(FALLBACK_MODELS.map((m) => m.value)).toContain('fable');
  });

  it('switch to Fable with maximum thinking', async () => {
    const { tools, patches } = control({ model: 'opus' });
    const r = await tools.chat_configure!.handler({ model: 'Fable', effort: 'max' }, {});
    expect(r.isError).toBeFalsy();
    expect(patches).toEqual([{ model: 'fable', effort: 'max' }]);
    expect(text(r)).toMatch(/Fable \(fable\) with thinking Max/);
  });

  it('step the effort down for a model without it and say so', async () => {
    const { tools, patches } = control();
    const r = await tools.chat_configure!.handler({ model: 'haiku', effort: 'max' }, {});
    expect(patches).toEqual([{ model: 'haiku', effort: 'high' }]);
    expect(text(r)).toMatch(/no max thinking level/);
  });

  it('change only the effort of the current model, or reset it', async () => {
    const { tools, patches } = control({ model: 'fable', effort: 'low' });
    await tools.chat_configure!.handler({ effort: 'xhigh' }, {});
    await tools.chat_configure!.handler({ effort: 'auto', model: 'default' }, {});
    expect(patches).toEqual([{ effort: 'xhigh' }, { model: null, effort: null }]);
  });

  it('refuse unknown models and empty calls without changing anything', async () => {
    const { tools, patches } = control();
    const unknown = await tools.chat_configure!.handler({ model: 'gpt-5' }, {});
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/Fable \(fable\)/);
    expect((await tools.chat_configure!.handler({}, {})).isError).toBe(true);
    expect(patches).toEqual([]);
  });

  it('list the current choice and the models with their levels', async () => {
    const { tools } = control({ model: 'fable', effort: 'max' });
    const r = text(await tools.chat_models!.handler({}, {}));
    expect(r).toMatch(/^Now: Fable \(fable\), thinking Max, billed to the Claude subscription\./);
    expect(r).toMatch(/- Haiku \(haiku\): Fast\. Thinking: low, medium, high/);
  });
});

describe('billing', () => {
  it('switches the chat to the API key and back when asked', async () => {
    const { tools, patches } = control();
    const r = await tools.chat_configure!.handler({ billing: 'api', model: 'opus' }, {});
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Anthropic API key/);
    expect(patches).toEqual([{ billing: 'api', model: 'opus' }]);
    await tools.chat_configure!.handler({ billing: 'subscription' }, {});
    expect(patches[1]).toEqual({ billing: 'subscription' });
    expect(describeChatChange({ billing: 'api', model: 'opus' })).toBe('model → opus, billing → API');
  });

  it('refuses the API when the chat may not use the key, and changes nothing', async () => {
    const { tools, patches } = control({}, MODELS, "Only the owner's chats can use the owner's Anthropic API key.");
    const r = await tools.chat_configure!.handler({ billing: 'api' }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/owner/);
    expect(patches).toEqual([]);
  });
});
