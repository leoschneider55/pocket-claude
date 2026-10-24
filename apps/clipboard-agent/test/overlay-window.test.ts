import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayWindow, type WindowEvent } from '../src/overlay/window.js';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  lines: string[] = [];
  killed = false;
  constructor() {
    super();
    let buf = '';
    this.stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      this.lines.push(...parts);
    });
  }
  kill(): boolean {
    this.killed = true;
    this.emit('exit', null);
    return true;
  }
}

const snap = (n: number) => ({ op: 'reset' as const, chatId: null, title: `snap ${n}`, status: { text: '', tone: 'idle' as const }, messages: [], chats: [], loading: false, config: null, theme: 'dark' as const });

function setup() {
  const children: FakeChild[] = [];
  const spawned: { command: string; args: string[] }[] = [];
  const events: WindowEvent[] = [];
  const logs: string[] = [];
  let snapshot = 0;
  const win = new OverlayWindow({
    script: 'C:\\overlay.ps1',
    snapshot: () => snap(++snapshot),
    log: (m) => logs.push(m),
    onEvent: (e) => events.push(e),
    spawn: ((command: string, args: string[]) => {
      spawned.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  return { win, children, spawned, events, logs };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('OverlayWindow', () => {
  it('runs the script with PowerShell, sends a snapshot first, then ops as JSON lines', async () => {
    const { win, children, spawned } = setup();
    win.start();
    expect(spawned[0]).toEqual({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\overlay.ps1'] });
    expect(win.send({ op: 'title', title: 'Chat' })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0]?.lines.map((l) => JSON.parse(l))).toEqual([snap(1), { op: 'title', title: 'Chat' }]);
  });

  it('parses events from stdout and logs everything else', async () => {
    const { win, children, events, logs } = setup();
    win.start();
    children[0]?.stdout.write('{"ev":"copied","what":"code"}\nnot json\n{"ev":"open","id":"c1"}\n{"ev":"send","chatId":"c1","text":"hi"}\n{"ev":"configure","chatId":"c1","effort":"max"}\n{"ev":"error","message":"bad"}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ ev: 'copied', what: 'code' }, { ev: 'open', id: 'c1' }, { ev: 'send', chatId: 'c1', text: 'hi' },
      { ev: 'configure', chatId: 'c1', effort: 'max' },
      { ev: 'error', message: 'bad' },
    ]);
    expect(logs).toEqual(['overlay: not json', 'overlay error: bad']);
  });

  it('restarts a crashed window with backoff and a fresh snapshot, but gives up eventually', async () => {
    const { win, children, logs } = setup();
    win.start();
    children[0]?.emit('exit', 1);
    expect(win.send({ op: 'title', title: 'x' })).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(children[1]!.lines[0]!)).toEqual(snap(2));

    children[1]?.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(children).toHaveLength(3);
    for (let i = 2; i < 6; i++) {
      children[i]?.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(children).toHaveLength(6);
    expect(logs[logs.length - 1]).toMatch(/giving up/);
  });

  it('asks the window to quit on close and kills it if it lingers', async () => {
    const { win, children } = setup();
    win.start();
    win.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(children[0]?.lines.map((l) => JSON.parse(l).op)).toEqual(['reset', 'quit']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(children[0]?.killed).toBe(true);
    expect(children).toHaveLength(1);
  });
});
