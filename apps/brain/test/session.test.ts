import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  readonly close = vi.fn(() => {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = null;
  });
  private readonly queue: SDKMessage[] = [];
  private waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null;
  private closed = false;

  constructor(readonly options: Options, readonly transcriptPath: string) {}

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
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
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
  appendFileSync(fake.transcriptPath, JSON.stringify(next.value) + '\n');
  return next.value;
}

beforeEach(() => {
  metas.length = 0;
  promptInput = undefined;
  mkdirSync(join(dirs.home, 'sessions'), { recursive: true });
  vi.mocked(query).mockImplementation(({ options, prompt }) => {
    const sessionId = String(options?.sessionId ?? options?.resume ?? 'missing-engine');
    const transcriptDirectory = join(dirs.base, 'transcripts');
    const transcriptPath = join(transcriptDirectory, sessionId + '.jsonl');
    mkdirSync(transcriptDirectory, { recursive: true });
    if (!existsSync(transcriptPath)) writeFileSync(transcriptPath, '');
    fake = new FakeQuery(options ?? {}, transcriptPath);
    promptInput = prompt as AsyncIterable<SDKUserMessage>;
    for (const matcher of options?.hooks?.SessionStart ?? []) {
      for (const callback of matcher.hooks) {
        void callback({
          hook_event_name: 'SessionStart',
          source: options?.resume ? 'resume' : 'startup',
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: String(options?.cwd ?? ''),
        }, undefined, { signal: new AbortController().signal });
      }
    }
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
      screenFrame: {
        image: { mime: 'image/jpeg' as const, dataBase64: 'ZmFrZS1qcGVn', width: 1280, height: 800 },
        windowTitle: 'Editor',
        capturedAt: 123,
        frameId: 'frame-1',
        retainFrames: 2,
      },
      observation: { windowTitle: 'Editor', capturedAt: 123, goal: 'Wait for the error dialog.' },
    };

    await s.send(turn);

    const input = await nextInputMessage();
    expect(input.origin).toEqual({ kind: 'channel', server: 'pocket-screen-watch' });
    expect(input.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: turn.screenFrame.image.dataBase64 } },
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
      screenFrame: {
        image: { mime: 'image/jpeg', dataBase64: 'ZmFrZS1qcGVn', width: 1280, height: 800 },
        windowTitle: 'Editor',
        capturedAt: 123,
        frameId: 'frame-2',
        retainFrames: 2,
      },
    });

    const input = await nextInputMessage();
    expect(input.origin).toEqual({ kind: 'human' });
    expect(input.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZS1qcGVn' } },
      { type: 'text', text: 'What is on screen?' },
    ]);
    s.stop();
  });

  it('keeps only the configured number of watch images and resumes the same engine when trimming', async () => {
    const hostHook = vi.fn();
    const s = newSession('aaaaaaaa-1111-2222-3333-444444444447', {}, {
      claudeOptions: () => ({
        hooks: { SessionStart: [{ hooks: [async () => { hostHook(); return {}; }] }] },
      }),
    });
    const makeFrame = (index: number) => ({
      image: { mime: 'image/jpeg' as const, dataBase64: Buffer.from('frame-' + index).toString('base64'), width: 1280, height: 800 },
      windowTitle: 'Editor ' + index,
      capturedAt: 1000 + index,
      frameId: 'frame-' + index,
      retainFrames: 2,
    });

    await s.send({ from: 'phone', text: 'first', screenFrame: makeFrame(1) });
    const first = await nextInputMessage();
    const engineId = s.meta.engine?.id;
    expect(first.uuid).toBeTruthy();
    expect(hostHook).toHaveBeenCalled();
    expect(fake.options.hooks?.SessionStart).toHaveLength(2);
    fake.push(RESULT);
    await settle();

    await s.send({ from: 'phone', text: 'second', screenFrame: makeFrame(2) });
    const second = await nextInputMessage();
    fake.push(RESULT);
    await settle();

    const oldQuery = fake;
    await s.send({ from: 'phone', text: 'third', screenFrame: makeFrame(3) });
    expect(fake).not.toBe(oldQuery);
    expect(oldQuery.close).toHaveBeenCalledOnce();
    expect(fake.options.resume).toBe(engineId);
    const third = await nextInputMessage();

    const transcript = readFileSync(fake.transcriptPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as SDKUserMessage);
    const firstContent = transcript[0]!.message.content;
    expect(firstContent).toEqual([
      { type: 'text', text: '[кадр экрана: Editor 1, 1970-01-01T00:00:01.001Z]' },
      { type: 'text', text: 'first' },
    ]);
    expect(transcript[0]!).toMatchObject({ uuid: first.uuid, origin: { kind: 'human' }, parent_tool_use_id: null });
    expect(transcript.slice(1).map((message) => message.uuid)).toEqual([second.uuid, third.uuid]);
    expect(transcript.slice(1).filter((message) => Array.isArray(message.message.content) && message.message.content.some((block) => block.type === 'image'))).toHaveLength(2);
    s.stop();
  });

  it('does not stop a running turn for frame retention housekeeping', async () => {
    const s = newSession('aaaaaaaa-1111-2222-3333-444444444448');
    const frame = (id: string) => ({
      image: { mime: 'image/jpeg' as const, dataBase64: Buffer.from(id).toString('base64'), width: 1280, height: 800 },
      windowTitle: 'Editor',
      capturedAt: 123,
      frameId: id,
      retainFrames: 1,
    });
    await s.send({ from: 'phone', text: 'first', screenFrame: frame('one') });
    await nextInputMessage();
    const activeQuery = fake;

    await s.send({ from: 'phone', text: 'second', screenFrame: frame('two') });

    expect(fake).toBe(activeQuery);
    expect(activeQuery.close).not.toHaveBeenCalled();
    s.stop();
  });

  it('deletes its watch index without deleting a user attachment', async () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444449';
    const s = newSession(id);
    const frame = {
      image: { mime: 'image/jpeg' as const, dataBase64: 'ZmFrZS1qcGVn', width: 1280, height: 800 },
      windowTitle: 'Editor',
      capturedAt: 123,
      frameId: 'destroy-frame',
      retainFrames: 2,
    };
    await s.send({
      from: 'phone',
      text: 'keep my file',
      screenFrame: frame,
      attachments: [{ mime: 'image/png', name: 'manual.png', dataBase64: Buffer.from('manual').toString('base64') }],
    });
    await nextInputMessage();

    const sidecar = join(dirs.home, 'sessions', id + '.watch-history.json');
    const attachment = join(chatFolder(s.meta), 'attachments', 'manual.png');
    expect(existsSync(sidecar)).toBe(true);
    expect(readFileSync(attachment, 'utf8')).toBe('manual');

    s.destroy();

    expect(existsSync(sidecar)).toBe(false);
    expect(readFileSync(attachment, 'utf8')).toBe('manual');
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
