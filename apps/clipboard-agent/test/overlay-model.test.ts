import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCREEN_WATCH_SETTINGS, type PayloadOf, type SessionEvent, type SessionMeta } from '@pocket/protocol';
import { firstWords, plural } from '../src/overlay/actions.js';
import { OverlayModel, SEND_TIMEOUT_MS, whenLabel, type OverlayMessage, type WindowOp } from '../src/overlay/model.js';
import { OVERLAY_PS, OVERLAY_PS_FILE } from '../src/overlay/script.js';

function setup(now?: () => number) {
  const ops: WindowOp[] = [];
  const requests: string[] = [];
  const watchRequests: PayloadOf<'screen.watch.set'>[] = [];
  const model = new OverlayModel({
    window: (op) => ops.push(op),
    request: (b) => {
      if (b.type === 'screen.watch.set') watchRequests.push(b.payload);
      requests.push(b.type === 'session.history' ? `history:${b.payload.sessionId}` : b.type === 'message.send' ? `send:${b.payload.sessionId}:${b.payload.text}` : b.type);
    },
    ...(now ? { now } : {}),
  });
  /** The newest op of a kind: events also refresh the status line and the chat list. */
  function latest<K extends WindowOp['op']>(op: K): Extract<WindowOp, { op: K }> {
    const found = [...ops].reverse().find((o) => o.op === op);
    if (!found) throw new Error(`no ${op} op`);
    return found as Extract<WindowOp, { op: K }>;
  }
  const upserts = () => ops.flatMap((o) => (o.op === 'upsert' ? [o.message] : []));
  return { model, ops, requests, watchRequests, latest, upserts };
}

const meta = (sessionId: string, updatedAt: number, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId,
  title: `Chat ${sessionId}`,
  state: 'idle',
  createdAt: updatedAt,
  updatedAt,
  ...extra,
});

const event = (sessionId: string, event: SessionEvent) => ({ type: 'session.event' as const, payload: { sessionId, event } });
const list = (...sessions: SessionMeta[]) => ({ type: 'session.list.result' as const, payload: { sessions } });
const history = (sessionId: string, events: SessionEvent[]) => ({ type: 'session.history.result' as const, payload: { sessionId, events } });

function actionsOf(m: OverlayMessage | undefined) {
  if (m?.role !== 'actions') throw new Error(`expected actions, got ${m?.role}`);
  return m;
}

describe('OverlayModel', () => {
  it('toggles screen watch for the active chat and renders the returned status', () => {
    const { model, requests, watchRequests, latest } = setup();
    model.handle(list(meta('a', 1)));
    model.toggleWatch();
    expect(requests.at(-1)).toBe('screen.watch.set');
    expect(watchRequests).toEqual([{ sessionId: 'a', enabled: true }]);

    model.handle({
      type: 'screen.watch.status',
      payload: {
        sessionId: 'a',
        watchId: 'watch-1',
        deviceId: 'pc-1',
        state: 'watching',
        settings: DEFAULT_SCREEN_WATCH_SETTINGS,
      },
    });
    expect(latest('status').status).toMatchObject({ watching: true, text: 'готово · 👁 Claude смотрит экран' });
    model.toggleWatch();
    expect(requests.at(-1)).toBe('screen.watch.set');
    expect(watchRequests).toEqual([{ sessionId: 'a', enabled: true }, { sessionId: 'a', enabled: false }]);
    model.handle({
      type: 'screen.watch.status',
      payload: { sessionId: 'a', watchId: 'watch-1', deviceId: 'pc-1', state: 'off', settings: { ...DEFAULT_SCREEN_WATCH_SETTINGS, intervalMs: 2500, maxPerMinute: 2 } },
    });
    model.toggleWatch();
    expect(watchRequests.at(-1)).toEqual({ sessionId: 'a', enabled: true });
  });

  it('asks for the chat list on connect, then follows the most recent visible chat', () => {
    const { model, ops, requests, latest } = setup();
    model.connected();
    expect(requests).toEqual(['session.list']);
    model.handle(list(meta('old', 1), meta('new', 5), meta('hidden', 9, { hidden: true })));
    expect(requests).toEqual(['session.list', 'history:new']);
    expect(latest('reset')).toMatchObject({ chatId: 'new', title: 'Chat new', messages: [], loading: true });

    model.handle(history('new', [{ kind: 'user', text: 'hi', from: 'phone' }, { kind: 'text', text: 'Hello `there`' }]));
    const reset = latest('reset');
    expect(reset.loading).toBe(false);
    expect(reset.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(reset.messages[1]).toMatchObject({ first: true, blocks: [{ type: 'paragraph', inline: [{ text: 'Hello ' }, { text: 'there', code: true }] }] });
    expect(reset.chats.map((c) => c.id)).toEqual(['new', 'old']);
    expect(ops.filter((o) => o.op === 'reset')).toHaveLength(2);
  });

  it('streams a reply as upserts of the same message and finalises it', () => {
    const { model, upserts } = setup();
    model.handle(list(meta('a', 1)));
    model.handle(history('a', []));

    model.handle(event('a', { kind: 'user', text: 'write code', from: 'phone' }));
    expect(upserts().at(-1)).toMatchObject({ role: 'user', text: 'write code' });
    model.handle(event('a', { kind: 'text_delta', text: 'Sure:\n```py\nprint(1)' }));
    const first = upserts().at(-1);
    expect(first).toMatchObject({ role: 'assistant', streaming: true, first: true });
    if (first?.role !== 'assistant') return;
    expect(first.blocks).toEqual([
      { type: 'paragraph', inline: [{ text: 'Sure:' }] },
      { type: 'code', lang: 'py', text: 'print(1)' },
    ]);
    model.handle(event('a', { kind: 'text_delta', text: '\n```' }));
    model.handle(event('a', { kind: 'text', text: 'Sure:\n```py\nprint(1)\n```' }));
    const done = upserts().at(-1);
    expect(done).toMatchObject({ id: first.id, streaming: false, text: 'Sure:\n```py\nprint(1)\n```' });
    const count = upserts().length;
    model.handle(event('a', { kind: 'result', durationMs: 10 }));
    expect(upserts()).toHaveLength(count);
  });

  it('folds calls in a row into one entry and names each by its first three words', () => {
    const { model, latest } = setup();
    model.handle(list(meta('a', 1)));
    model.handle(
      history('a', [
        { kind: 'user', text: 'fix it', from: 'phone' },
        { kind: 'tool_use', id: 't1', name: 'run_command', input: { command: 'pnpm test --filter mobile' } },
        { kind: 'tool_result', id: 't1', content: '1 failed', isError: false },
        { kind: 'tool_use', id: 't2', name: 'read_file', input: { path: 'C:\\repo\\apps\\mobile\\src\\components\\TypingBubble.tsx' } },
        { kind: 'tool_result', id: 't2', content: '1\tline', isError: false },
        { kind: 'tool_use', id: 't3', name: 'edit_file', input: { path: 'src/a.ts', old_string: 'a()', new_string: 'b()' } },
        { kind: 'tool_result', id: 't3', content: 'not unique', isError: true },
        { kind: 'text', text: 'Fixed.' },
      ]),
    );
    const [user, run, reply] = latest('reset').messages;
    expect(user?.role).toBe('user');
    const actions = actionsOf(run);
    expect(actions.group).toEqual({ label: '3 действия', summary: '1 ошибка · Команда · Чтение · Правка' });
    expect(actions.state).toBe('error');
    expect(actions.actions.map((a) => [a.kind, a.label, a.short, a.state])).toEqual([
      ['command', 'Команда', 'pnpm test --filter…', 'done'],
      ['read', 'Чтение', '…components\\TypingBubble.tsx', 'done'],
      ['edit', 'Правка', 'src/a.ts', 'error'],
    ]);
    // Opening a row shows everything: the full command and what came back.
    expect(actions.actions[0]?.parts).toEqual([
      { label: 'Команда', text: 'pnpm test --filter mobile' },
      { label: 'Результат', text: '1 failed' },
    ]);
    expect(actions.actions[2]?.parts).toEqual([
      { label: 'Файл', text: 'src/a.ts' },
      { label: 'Было', text: 'a()' },
      { label: 'Стало', text: 'b()' },
      { label: 'Ошибка', text: 'not unique' },
    ]);
    expect(reply).toMatchObject({ role: 'assistant', first: true });
  });

  it('keeps one or two calls as separate rows and folds them once a third arrives, under the same id', () => {
    const { model, upserts } = setup();
    model.handle(list(meta('a', 1, { state: 'running' })));
    model.handle(history('a', [{ kind: 'user', text: 'go', from: 'phone' }]));
    model.handle(event('a', { kind: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'usePowerSaving' } }));
    model.handle(event('a', { kind: 'tool_use', id: 't2', name: 'glob', input: { pattern: '**/*.tsx' } }));
    const two = actionsOf(upserts().at(-1));
    expect(two.group).toBeUndefined();
    expect(two.actions.map((a) => a.state)).toEqual(['running', 'running']);
    model.handle(event('a', { kind: 'tool_use', id: 't3', name: 'mcp__pocket__pc_screenshot', input: {} }));
    const three = actionsOf(upserts().at(-1));
    expect(three.id).toBe(two.id);
    expect(three.group).toEqual({ label: '3 действия', summary: 'сейчас: Скриншот ПК' });
    expect(three.actions[2]).toMatchObject({ kind: 'screen', label: 'Скриншот ПК', short: '' });
  });

  it('shows a call as running, then waiting for approval, then cut off when Claude stops', () => {
    const { model, latest } = setup();
    model.handle(list(meta('a', 1, { state: 'running' })));
    model.handle(history('a', [{ kind: 'user', text: 'start it', from: 'phone' }, { kind: 'tool_use', id: 't1', name: 'run_command', input: { command: 'npm run dev' } }]));
    expect(actionsOf(latest('reset').messages[1]).state).toBe('running');
    expect(latest('reset').status).toEqual({ text: 'выполняет: Команда npm run dev', tone: 'busy' });

    model.handle(event('a', { kind: 'state', state: 'waiting_permission' }));
    expect(actionsOf(latest('upsert').message).actions[0]?.state).toBe('waiting');
    expect(latest('status').status).toEqual({ text: 'ждёт разрешения на телефоне', tone: 'wait' });

    model.handle(event('a', { kind: 'state', state: 'idle' }));
    expect(actionsOf(latest('upsert').message).actions[0]?.state).toBe('stopped');
    expect(latest('status').status).toEqual({ text: 'готово', tone: 'idle' });
  });

  it('puts what the user attached on their message, and says when it was spoken', () => {
    const { model, latest } = setup();
    model.handle(list(meta('a', 1)));
    model.handle(history('a', [{ kind: 'user', text: 'look', from: 'phone', images: 2, files: ['report.pdf'], voice: true }]));
    expect(latest('reset').messages[0]).toMatchObject({
      role: 'user',
      voice: true,
      attachments: { kind: 'attach', label: 'Вложения', short: '2 изображения, report.pdf', parts: [{ label: 'Приложено', text: '2 изображения\nreport.pdf' }] },
    });
  });

  it('captions only the first reply of a turn', () => {
    const { model, latest } = setup();
    model.handle(list(meta('a', 1)));
    model.handle(
      history('a', [
        { kind: 'user', text: 'q1', from: 'phone' },
        { kind: 'text', text: 'looking' },
        { kind: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
        { kind: 'tool_result', id: 't1', content: 'x', isError: false },
        { kind: 'text', text: 'found it' },
        { kind: 'user', text: 'q2', from: 'phone' },
        { kind: 'text', text: 'sure' },
      ]),
    );
    const replies = latest('reset').messages.flatMap((m) => (m.role === 'assistant' ? [m.first] : []));
    expect(replies).toEqual([true, false, true]);
  });

  it('switches to the chat the phone types in, to new chats, and away from deleted ones', () => {
    const { model, requests, latest, ops } = setup();
    model.handle(list(meta('a', 2), meta('b', 1)));
    model.handle(history('a', []));

    model.handle(event('b', { kind: 'user', text: 'over here', from: 'phone' }));
    expect(requests).toEqual(['history:a', 'history:b']);
    expect(latest('reset')).toMatchObject({ chatId: 'b', title: 'Chat b' });
    model.handle(history('b', [{ kind: 'user', text: 'over here', from: 'phone' }]));
    expect(latest('reset')).toMatchObject({ title: 'Chat b', messages: [{ role: 'user', text: 'over here' }] });

    model.handle({ type: 'session.created', payload: { session: meta('c', 3) } });
    expect(latest('reset')).toMatchObject({ chatId: 'c', title: 'Chat c', messages: [] });
    model.handle({ type: 'session.updated', payload: { session: meta('c', 4, { title: 'Renamed' }) } });
    expect(latest('title')).toEqual({ op: 'title', title: 'Renamed' });
    expect(latest('chats').chats.find((c) => c.id === 'c')?.title).toBe('Renamed');

    model.handle({ type: 'session.deleted', payload: { sessionId: 'c' } });
    expect(latest('reset')).toMatchObject({ chatId: 'b', title: 'Chat b' });
    model.handle({ type: 'session.deleted', payload: { sessionId: 'b' } });
    model.handle({ type: 'session.deleted', payload: { sessionId: 'a' } });
    expect(ops.at(-1)).toEqual({ op: 'reset', chatId: null, title: 'Чатов пока нет', status: { text: '', tone: 'idle' }, messages: [], chats: [], loading: false, theme: 'dark' });
  });

  it('lists chats newest first with their state, and opens the one picked in the window', () => {
    const now = new Date(2026, 9, 23, 15, 0).getTime();
    const { model, ops, requests, latest } = setup(() => now);
    model.handle(
      list(
        meta('a', new Date(2026, 9, 23, 14, 5).getTime(), { lastText: 'hello\n  world' }),
        meta('b', new Date(2026, 9, 22, 9, 0).getTime(), { state: 'running' }),
        meta('c', new Date(2026, 9, 12, 9, 0).getTime(), { state: 'waiting_permission' }),
        meta('d', new Date(2025, 2, 1, 9, 0).getTime()),
      ),
    );
    expect(latest('reset').chats).toEqual([
      { id: 'a', title: 'Chat a', preview: 'hello world', when: '14:05', tone: 'idle', active: true },
      { id: 'b', title: 'Chat b', preview: '', when: 'работает…', tone: 'busy', active: false },
      { id: 'c', title: 'Chat c', preview: '', when: 'ждёт разрешения', tone: 'wait', active: false },
      { id: 'd', title: 'Chat d', preview: '', when: '01.03.2025', tone: 'idle', active: false },
    ]);

    model.open('c');
    expect(latest('reset')).toMatchObject({ chatId: 'c', loading: true, status: { tone: 'wait' } });
    expect(latest('reset').chats.find((c) => c.active)?.id).toBe('c');
    expect(requests).toEqual(['history:a', 'history:c']);
    const count = ops.length;
    model.open('c');
    model.open('nope');
    expect(ops).toHaveLength(count);
  });

  it('stays on the chat being read after a reconnect and reloads it', () => {
    const { model, requests, latest } = setup();
    model.handle(list(meta('a', 1), meta('b', 2)));
    model.handle(history('b', []));
    model.open('a');
    model.handle(history('a', []));
    model.offline();
    expect(latest('status').status).toEqual({ text: 'Mac не в сети', tone: 'offline' });
    model.connected();
    model.handle(list(meta('a', 1), meta('b', 2)));
    expect(latest('reset')).toMatchObject({ chatId: 'a', loading: true });
    expect(requests).toEqual(['history:b', 'history:a', 'session.list', 'history:a']);
    expect(latest('reset').status).toEqual({ text: 'готово', tone: 'idle' });
  });

  it('carries the theme in snapshots and pushes a change to the window', () => {
    const { model, ops, latest } = setup();
    model.handle(list());
    expect(latest('reset')).toMatchObject({ theme: 'dark' });
    model.setTheme('light');
    expect(ops.at(-1)).toEqual({ op: 'theme', theme: 'light' });
    model.setTheme('light');
    expect(ops.filter((o) => o.op === 'theme')).toHaveLength(1);
    expect(model.snapshot()).toMatchObject({ op: 'reset', theme: 'light' });
    expect(new OverlayModel({ window: () => {}, request: () => {} }, 'light').snapshot()).toMatchObject({ theme: 'light' });
  });

  it('ignores events for the active chat until its history arrived, then draws from the history', () => {
    const { model, latest, upserts } = setup();
    model.handle(list(meta('a', 1)));
    model.handle(event('a', { kind: 'text', text: 'early' }));
    expect(upserts()).toEqual([]);
    model.handle(history('a', [{ kind: 'text', text: 'early' }]));
    expect(latest('reset')).toMatchObject({ messages: [{ role: 'assistant', text: 'early' }] });
  });
});

describe('writing from the window', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the text to the chat and confirms once the brain has put it in', () => {
    const { model, ops, requests, upserts } = setup();
    model.handle(list(meta('a', 1)));
    model.handle(history('a', []));
    model.send('a', '  Привет с ПК\n');
    expect(requests.at(-1)).toBe('send:a:Привет с ПК');
    // Somebody else's message in the meantime is not the echo.
    model.handle(event('a', { kind: 'user', text: 'с телефона', from: 'phone' }));
    expect(ops.some((o) => o.op === 'sent' || o.op === 'unsent')).toBe(false);
    model.handle(event('a', { kind: 'user', text: 'Привет с ПК', from: 'pc' }));
    expect(upserts().at(-1)).toMatchObject({ role: 'user', text: 'Привет с ПК' });
    expect(ops.at(-1)).toEqual({ op: 'sent', text: 'Привет с ПК' });
  });

  it('gives the text back when it cannot go: empty, no chat, an error, no answer, Mac offline', () => {
    vi.useFakeTimers();
    const { model, requests, latest } = setup();
    model.handle(list(meta('a', 1)));
    model.handle(history('a', []));
    model.send('a', '   ');
    expect(latest('unsent')).toEqual({ op: 'unsent', text: '', error: 'Пустое сообщение' });
    model.send('gone', 'hi');
    expect(latest('unsent')).toEqual({ op: 'unsent', text: 'hi', error: 'Этого чата больше нет' });

    model.send('a', 'first');
    model.send('a', 'second');
    expect(latest('unsent')).toEqual({ op: 'unsent', text: 'second', error: 'Предыдущее сообщение ещё отправляется' });
    model.handle({ type: 'error', payload: { code: 'unknown_session', message: 'Session not found' } });
    expect(latest('unsent')).toEqual({ op: 'unsent', text: 'first', error: 'Этого чата нет на Mac' });

    model.send('a', 'into the void');
    vi.advanceTimersByTime(SEND_TIMEOUT_MS - 1);
    expect(latest('unsent').text).toBe('first');
    vi.advanceTimersByTime(1);
    expect(latest('unsent')).toMatchObject({ text: 'into the void', error: expect.stringContaining('Mac не ответил') });

    model.send('a', 'cut off');
    model.offline();
    expect(latest('unsent')).toEqual({ op: 'unsent', text: 'cut off', error: 'Mac не в сети, сообщение не отправлено' });
    model.send('a', 'still offline');
    expect(latest('unsent')).toEqual({ op: 'unsent', text: 'still offline', error: 'Mac не в сети, сообщение не отправлено' });
    expect(requests.filter((r) => r.startsWith('send:'))).toEqual(['send:a:first', 'send:a:into the void', 'send:a:cut off']);
  });

  it('reports trouble that comes after the message went in', () => {
    const { model, ops } = setup();
    model.handle(list(meta('a', 1)));
    model.handle({ type: 'error', payload: { code: 'claude_failed', message: 'spawn claude ENOENT' } });
    expect(ops.at(-1)).toEqual({ op: 'notice', text: 'Claude не запустился: spawn claude ENOENT' });
  });
});

describe('action labels', () => {
  it('keeps the first three words, the end of long paths and the host of URLs', () => {
    expect(firstWords('pnpm test --filter mobile')).toBe('pnpm test --filter…');
    expect(firstWords('  git   status ')).toBe('git status');
    expect(firstWords('/Users/me/projects/pocket-claude/apps/mobile/src/components/TypingBubble.tsx')).toBe('…components/TypingBubble.tsx');
    expect(firstWords('https://docs.example.com/a/very/long/path/that/goes/on/and/on/forever.html')).toBe('docs.example.com/a/very/long/path/that/goes/on/…');
    expect(firstWords('')).toBe('');
  });

  it('counts in Russian', () => {
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, 'действие', 'действия', 'действий'))).toEqual([
      '1 действие',
      '2 действия',
      '5 действий',
      '11 действий',
      '21 действие',
      '22 действия',
      '25 действий',
    ]);
  });

  it('dates chats like a messenger', () => {
    const now = new Date(2026, 0, 1, 0, 30).getTime();
    expect(whenLabel(new Date(2026, 0, 1, 0, 5).getTime(), now)).toBe('00:05');
    expect(whenLabel(new Date(2025, 11, 31, 23, 0).getTime(), now)).toBe('вчера');
    expect(whenLabel(new Date(2025, 11, 30, 23, 0).getTime(), now)).toBe('30.12.2025');
    expect(whenLabel(new Date(2026, 0, 1, 0, 5).getTime(), new Date(2026, 4, 9).getTime())).toBe('1 янв');
  });
});

describe('overlay script', () => {
  it('is PowerShell 5.1 and C# 5 without template leftovers', () => {
    const script = readFileSync(new URL('../src/overlay/script.ts', import.meta.url), 'utf8');
    expect(script).not.toMatch(/\$\{/);
    expect(OVERLAY_PS).toContain('GetAsyncKeyState');
    expect(OVERLAY_PS).toContain('ShowActivated = false');
    expect(OVERLAY_PS).toContain('Emit("send", "chatId", chatId, "text", text)');
    // Features the .NET Framework C# compiler behind Add-Type does not know.
    expect(OVERLAY_PS).not.toMatch(/\?\.|\$"|nameof\(/);
  });

  it('goes to disk with a byte order mark so Windows PowerShell reads the Russian labels as UTF-8', () => {
    expect(OVERLAY_PS_FILE.charCodeAt(0)).toBe(0xfeff);
    expect(OVERLAY_PS_FILE.slice(1)).toBe(OVERLAY_PS);
    expect(OVERLAY_PS).toMatch(/[а-я]/);
  });

  // PowerShell 7 parses 5.1 syntax; CI runners and Macs with pwsh get a real syntax check, elsewhere the test is skipped.
  const pwsh = process.env.POCKET_PWSH ?? 'pwsh';
  const hasPwsh = (() => {
    try {
      execFileSync(pwsh, ['-NoProfile', '-c', '1'], { stdio: 'ignore', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } });
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!hasPwsh)('parses without syntax errors', () => {
    const file = join(tmpdir(), `pocket-overlay-${process.pid}.ps1`);
    writeFileSync(file, OVERLAY_PS_FILE);
    const check = [
      '$t = $null; $e = $null',
      "[System.Management.Automation.Language.Parser]::ParseFile('" + file.replace(/'/g, "''") + "', [ref]$t, [ref]$e) | Out-Null",
      'if ($e) { $e | ForEach-Object { "{0}: {1}" -f $_.Extent.StartLineNumber, $_.Message }; exit 1 }',
      "'ok'",
    ].join('; ');
    const out = execFileSync(pwsh, ['-NoProfile', '-c', check], { encoding: 'utf8', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } });
    expect(out.trim()).toBe('ok');
  });
});
