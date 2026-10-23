import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEvent, SessionMeta } from '@pocket/protocol';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => {
  const base = `${(process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')}/pocket-session-test-${process.pid}`;
  process.env.POCKET_HOME = `${base}/home`;
  process.env.POCKET_WORKSPACE = `${base}/workspace`;
  process.env.POCKET_SKILLS_DIR = `${base}/no-skills`;
  return { base, home: `${base}/home`, workspace: `${base}/workspace` };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importActual) => ({ ...(await importActual<object>()), query: vi.fn() }));

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { Session } = await import('../src/session.js');
const { chatFolder, DEFAULT_MAC_WORKSPACE } = await import('../src/sandbox.js');
type Host = ConstructorParameters<typeof Session>[1];

/** Stands in for the Claude Code process: the test pushes the messages it would stream. */
class FakeQuery {
  readonly setModel = vi.fn(async (_model?: string) => {});
  readonly applyFlagSettings = vi.fn(async (_settings: Record<string, unknown>) => {});
  readonly supportedModels = vi.fn(async () => [{ value: 'fable', displayName: 'Fable', description: 'Deepest', supportedEffortLevels: ['low', 'high', 'max'] }]);
  readonly interrupt = vi.fn(async () => undefined);
  private readonly queue: SDKMessage[] = [];
  private waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null;

  constructor(readonly options: Options) {}

  push(msg: Record<string, unknown>): void {
    const m = msg as unknown as SDKMessage;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: m, done: false });
    } else this.queue.push(m);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const m = this.queue.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

const RESULT = { type: 'result', subtype: 'success', duration_ms: 5, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
const settle = () => new Promise((r) => setTimeout(r, 10));

let fake: FakeQuery;
const metas: SessionMeta[] = [];
let promptInput: AsyncIterable<SDKUserMessage> | undefined;

function host(over: Partial<Host> = {}): Host {
  return {
    executorFor: () => ({ id: undefined, online: false, info: null, root: undefined, call: async () => ({ content: '', isError: true }) }),
    pcFor: () => ({ id: undefined, name: undefined, online: false, capabilities: [], clipboardRead: async () => ({}), clipboardWrite: async () => ({}), screenshot: async () => ({}), computer: async () => ({}) }),
    chatOnly: () => false,
    userName: () => 'Owner',
    emit: () => {},
    metaChanged: (m) => void metas.push(m),
    canUseTool: async (_s, _t, input) => ({ behavior: 'allow', updatedInput: input }),
    claudeOptions: () => ({}),
    onClaudeVersion: () => {},
    ...over,
  };
}

function newSession(id = 'aaaaaaaa-1111-2222-3333-444444444444', over: Partial<SessionMeta> = {}, hostOver: Partial<Host> = {}) {
  const now = Date.UTC(2026, 9, 23, 12);
  return new Session({ sessionId: id, title: 'Test', state: 'idle', createdAt: now, updatedAt: now, userId: 'owner', ...over }, host(hostOver), false);
}

const appended = () => (fake.options.systemPrompt as { append?: string }).append ?? '';

async function nextInputMessage(): Promise<SDKUserMessage> {
  if (!promptInput) throw new Error('session prompt input was not captured');
  const next = await promptInput[Symbol.asyncIterator]().next();
  if (next.done) throw new Error('session prompt input ended');
  return next.value;
}

beforeEach(() => {
  metas.length = 0;
  promptInput = undefined;
  mkdirSync(join(dirs.home, 'sessions'), { recursive: true });
  vi.mocked(query).mockImplementation(({ options, prompt }) => {
    fake = new FakeQuery(options ?? {});
    promptInput = prompt as AsyncIterable<SDKUserMessage>;
    return fake as unknown as Query;
  });
});

afterAll(() => rmSync(dirs.base, { recursive: true, force: true }));

describe('Claude switching its own model', () => {
  it('gets the chat_* tools in the Mac prompt and allow list', async () => {
    const s = newSession();
    await s.send({ text: 'hi', from: 'phone' });
    expect(fake.options.allowedTools).toEqual(expect.arrayContaining(['mcp__pocket__chat_models', 'mcp__pocket__chat_configure']));
    expect(JSON.stringify(fake.options.systemPrompt)).toMatch(/chat_configure/);
    s.stop();
  });

  it('shows the change at once and applies it to the live process only after the turn', async () => {
    const s = newSession();
    await s.send({ text: 'switch to Fable and think at maximum', from: 'phone' });
    expect(s.meta.state).toBe('running');

    s.configureAfterTurn({ model: 'fable', effort: 'max' });
    expect(s.meta).toMatchObject({ model: 'fable', effort: 'max' });
    expect(metas.at(-1)).toMatchObject({ model: 'fable', effort: 'max' });
    await settle();
    expect(fake.setModel).not.toHaveBeenCalled();
    expect(fake.applyFlagSettings).not.toHaveBeenCalled();

    fake.push(RESULT);
    await settle();
    expect(fake.setModel).toHaveBeenCalledWith('fable');
    expect(fake.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' });
    s.stop();
  });

  it('starts the next process with the new model when the old one stopped first', async () => {
    const s = newSession('bbbbbbbb-1111-2222-3333-444444444444');
    await s.send({ text: 'use Fable', from: 'phone' });
    s.configureAfterTurn({ model: 'fable' });
    s.stop();
    const first = fake;
    await s.send({ text: 'again', from: 'phone' });
    expect(fake).not.toBe(first);
    expect(fake.options.model).toBe('fable');
    expect(first.setModel).not.toHaveBeenCalled();
    s.stop();
  });
});

describe('screen observation input', () => {
  it('attaches observation frames with channel provenance and keeps them out of lastText', async () => {
    const events: SessionEvent[] = [];
    const s = newSession('aaaaaaaa-1111-2222-3333-444444444445', {}, { emit: (_id, event) => events.push(event) });
    const turn = {
      from: 'screen-watch',
      text: 'Review this screen frame.',
      screenFrame: { image: 'ZmFrZS1qcGVn', windowTitle: 'Editor', capturedAt: 123, frameId: 'frame-1', retainFrames: 2 },
      observation: { windowTitle: 'Editor', capturedAt: 123, goal: 'Wait for the error dialog.' },
    };

    await s.send(turn);

    const input = await nextInputMessage();
    expect(input.origin).toEqual({ kind: 'channel', server: 'pocket-screen-watch' });
    expect(input.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: turn.screenFrame.image } },
      { type: 'text', text: turn.text },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'user', from: 'screen-watch', observation: true, images: 1 }));
    expect(s.meta.lastText).toBeUndefined();
    s.stop();
  });

  it('keeps a frame attached to a user turn human-originated', async () => {
    const s = newSession('aaaaaaaa-1111-2222-3333-444444444446');

    await s.send({
      from: 'phone',
      text: 'What is on screen?',
      screenFrame: { image: 'ZmFrZS1qcGVn', windowTitle: 'Editor', capturedAt: 123, frameId: 'frame-2', retainFrames: 2 },
    });

    const input = await nextInputMessage();
    expect(input.origin).toEqual({ kind: 'human' });
    expect(input.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZS1qcGVn' } },
      { type: 'text', text: 'What is on screen?' },
    ]);
    s.stop();
  });
});

describe('a sandbox per Mac chat', () => {
  it('gives a new chat its own folder, the Seatbelt sandbox and edits without asking', async () => {
    const s = newSession('feedfacecafe');
    await s.send({ text: 'hi', from: 'phone' });
    const folder = chatFolder(s.meta);
    expect(folder).toBe(`${dirs.workspace}/chats/2026-10-23-feedface`);
    expect(fake.options.cwd).toBe(folder);
    expect(existsSync(folder)).toBe(true);
    expect(s.meta.engine?.cwd).toBe(folder);
    expect(fake.options.permissionMode).toBe('acceptEdits');
    expect(fake.options.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: false });
    expect(appended()).toMatch(/This chat's own folder/);
    expect(appended()).toMatch(/# Sandbox/);
    s.stop();
  });

  it('puts the notes from earlier back into the prompt and keeps attachments in the folder', async () => {
    const s = newSession('notesnotes');
    const folder = chatFolder(s.meta);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'NOTES.md'), 'The user is building a slide deck in deck/.');
    await s.send({ text: 'look', from: 'phone', attachments: [{ mime: 'text/plain', name: 'brief.txt', dataBase64: Buffer.from('brief').toString('base64') }] });
    expect(appended()).toMatch(/## NOTES\.md\nThe user is building a slide deck/);
    expect(readFileSync(join(folder, 'attachments', 'brief.txt'), 'utf8')).toBe('brief');
    s.stop();
  });

  it('leaves chats that already live in the shared folder there, asking for edits as before', async () => {
    const s = newSession('legacychat', { engine: { id: 'old-engine', cwd: DEFAULT_MAC_WORKSPACE } });
    await s.send({ text: 'hi', from: 'phone' });
    expect(fake.options.cwd).toBe(DEFAULT_MAC_WORKSPACE);
    expect(fake.options.resume).toBe('old-engine');
    expect(fake.options.permissionMode).toBe('default');
    expect(appended()).not.toMatch(/own folder/);
    s.stop();
  });

  it('runs without the sandbox when POCKET_SANDBOX=off', async () => {
    process.env.POCKET_SANDBOX = 'off';
    try {
      const s = newSession('nosandbox');
      await s.send({ text: 'hi', from: 'phone' });
      expect(fake.options.sandbox).toBeUndefined();
      expect(appended()).not.toMatch(/# Sandbox/);
      s.stop();
    } finally {
      delete process.env.POCKET_SANDBOX;
    }
  });
});
