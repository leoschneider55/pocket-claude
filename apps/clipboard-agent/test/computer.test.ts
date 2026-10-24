import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { COMPUTER_PS, ComputerHost, hostCommand, timeoutFor } from '../src/computer.js';
import { EXT } from '../src/keys.js';

const dir = mkdtempSync(join(tmpdir(), 'pocket-computer-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CS_START = COMPUTER_PS.indexOf("@'\n") + 3;
const CS_END = COMPUTER_PS.indexOf("\n'@");
const CSHARP = COMPUTER_PS.slice(CS_START, CS_END);

describe('computer steps for the host', () => {
  it('fill in defaults and turn key names into codes', () => {
    expect(hostCommand({ action: 'screenshot' })).toEqual({ op: 'screenshot', display: -1, maxWidth: 1280, maxHeight: 800 });
    expect(hostCommand({ action: 'click', button: 'left', count: 2 })).toEqual({ op: 'click', x: 0, y: 0, at: false, button: 'left', count: 2, mods: [] });
    expect(hostCommand({ action: 'click', x: 5, y: 6, button: 'right', count: 1, modifiers: ['shift'] })).toMatchObject({ at: true, x: 5, y: 6, mods: [0x10] });
    expect(hostCommand({ action: 'drag', path: [[1, 2], [3, 4]] })).toEqual({ op: 'drag', path: [1, 2, 3, 4], button: 'left' });
    expect(hostCommand({ action: 'key', keys: 'super+e Return' })).toEqual({ op: 'keys', combos: [[0x5b | EXT, 0x45], [0x0d]], holdMs: 0 });
    expect(hostCommand({ action: 'window', handle: '42', op: 'close' })).toEqual({ op: 'window', handle: '42', what: 'close' });
    expect(hostCommand({ action: 'open', target: 'notepad' })).toEqual({ op: 'open', target: 'notepad', args: '' });
    expect(() => hostCommand({ action: 'key', keys: 'hyper+x' })).toThrow(/Unknown key/);
  });

  it('give long typing and holds more time', () => {
    expect(timeoutFor({ op: 'cursor' })).toBe(20_000);
    expect(timeoutFor({ op: 'type', text: 'x'.repeat(1000) })).toBe(30_000);
    expect(timeoutFor({ op: 'keys', combos: [[1], [2]], holdMs: 5000 })).toBe(20_200);
  });

  it('capture the screen with a CopyPixelOperation .NET Framework accepts (a combined value throws there)', () => {
    expect(COMPUTER_PS).toContain('CopyPixelOperation.SourceCopy);');
    expect(COMPUTER_PS).not.toMatch(/CopyPixelOperation\.\w+\s*\|/);
  });

  it('keep the script ASCII without backticks, so Windows PowerShell reads it as written', () => {
    expect(/[^\x00-\x7f]/.test(COMPUTER_PS)).toBe(false);
    expect(COMPUTER_PS.includes('`')).toBe(false);
    for (const op of ['screenshot', 'watchSample', 'watchCapture', 'zoom', 'move', 'click', 'button', 'drag', 'scroll', 'type', 'keys', 'cursor', 'windows', 'window', 'open', 'release']) {
      expect(COMPUTER_PS).toContain(`'${op}' {`);
    }
    expect(COMPUTER_PS).toContain('InputDesktopLocked()');
    expect(COMPUTER_PS).toContain('StretchBlt(dst, 0, 0, width, height');
  });
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests: { id: number; cmd: { op: string } }[] = [];
  killed = false;
  constructor() {
    super();
    let buf = '';
    this.stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const p of parts) this.requests.push(JSON.parse(p));
    });
  }
  say(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('exit', null));
    return true;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeHost() {
  const children: FakeChild[] = [];
  const host = new ComputerHost({
    script: 'C:\\computer.ps1',
    log: () => {},
    spawn: (() => {
      const c = new FakeChild();
      children.push(c);
      return c;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  return { host, children };
}

describe('ComputerHost', () => {
  it('starts the helper once, waits for it, and matches answers to steps', async () => {
    const { host, children } = fakeHost();
    const a = host.act({ action: 'cursor' });
    const b = host.act({ action: 'windows' });
    await tick();
    expect(children).toHaveLength(1);
    expect(children[0]!.requests).toEqual([]);
    children[0]!.say({ ready: true });
    await tick();
    expect(children[0]!.requests.map((r) => r.cmd.op)).toEqual(['cursor']);
    children[0]!.say({ id: children[0]!.requests[0]!.id, ok: true, result: { cursor: { x: 1, y: 2 } } });
    expect(await a).toEqual({ cursor: { x: 1, y: 2 } });
    await tick();
    const second = children[0]!.requests[1]!;
    expect(second.cmd.op).toBe('windows');
    children[0]!.say({ id: second.id, ok: false, error: 'blocked' });
    await expect(b).rejects.toThrow('blocked');
  });

  it('uses the persistent host for watch samples and bounded full captures', async () => {
    const { host, children } = fakeHost();
    const sample = host.sample(1);
    await tick();
    children[0]!.say({ ready: true });
    await tick();
    const sampleRequest = children[0]!.requests[0]!;
    expect(sampleRequest.cmd).toEqual({ op: 'watchSample', display: 1 });
    children[0]!.say({
      id: sampleRequest.id,
      ok: true,
      result: { locked: false, pixelsBase64: Buffer.alloc(160 * 90).toString('base64'), width: 160, height: 90 },
    });
    expect(await sample).toMatchObject({ locked: false, width: 160, height: 90, pixels: expect.any(Uint8Array) });

    const capture = host.capture(0);
    await tick();
    const captureRequest = children[0]!.requests[1]!;
    expect(captureRequest.cmd).toEqual({ op: 'watchCapture', display: 0 });
    children[0]!.say({
      id: captureRequest.id,
      ok: true,
      result: {
        locked: false,
        image: { mime: 'image/jpeg', dataBase64: 'aGVsbG8=', width: 1280, height: 800 },
        windowTitle: 'Editor',
        processName: 'editor',
        display: 0,
      },
    });
    await expect(capture).resolves.toMatchObject({ locked: false, windowTitle: 'Editor', display: 0 });
    expect(children).toHaveLength(1);
  });

  it('restarts the helper after it crashes', async () => {
    const { host, children } = fakeHost();
    const a = host.act({ action: 'cursor' });
    await tick();
    children[0]!.say({ ready: true });
    await tick();
    children[0]!.emit('exit', 1);
    await expect(a).rejects.toThrow(/stopped/);
    const b = host.act({ action: 'cursor' });
    await tick();
    expect(children).toHaveLength(2);
    children[1]!.say({ ready: true });
    await tick();
    children[1]!.say({ id: children[1]!.requests[0]!.id, ok: true, result: {} });
    expect(await b).toEqual({});
  });

  it('on the kill switch drops queued steps, ends the one in flight and lets go of the keys in a fresh helper', async () => {
    const { host, children } = fakeHost();
    const typing = host.act({ action: 'type', text: 'a long text' });
    const queued = host.act({ action: 'key', keys: 'Return' });
    await tick();
    children[0]!.say({ ready: true });
    await tick();
    expect(children[0]!.requests.map((r) => r.cmd.op)).toEqual(['type']);
    host.release();
    await expect(typing).rejects.toThrow('Stopped by the user.');
    await expect(queued).rejects.toThrow('Stopped by the user.');
    expect(children[0]!.killed).toBe(true);
    await tick();
    expect(children).toHaveLength(2);
    children[1]!.say({ ready: true });
    await tick();
    expect(children[1]!.requests.map((r) => r.cmd.op)).toEqual(['release']);
  });

  it('does not start a helper just to release when computer use was never used', async () => {
    const { host, children } = fakeHost();
    host.release();
    await tick();
    expect(children).toHaveLength(0);
  });
});

const pwsh = process.env.POCKET_PWSH ?? 'pwsh';
const env = { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' };
const has = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', env });
    return true;
  } catch {
    return false;
  }
};
const hasPwsh = has(pwsh, ['-NoProfile', '-c', '1']);
const hasMcs = has('mcs', ['--version']);

describe('the host script', () => {
  it.skipIf(!hasPwsh)('parses without PowerShell syntax errors', () => {
    const file = join(dir, 'computer.ps1');
    writeFileSync(file, COMPUTER_PS);
    const check = [
      '$t = $null; $e = $null',
      "[System.Management.Automation.Language.Parser]::ParseFile('" + file.replace(/'/g, "''") + "', [ref]$t, [ref]$e) | Out-Null",
      'if ($e) { $e | ForEach-Object { "{0}: {1}" -f $_.Extent.StartLineNumber, $_.Message }; exit 1 }',
      "'ok'",
    ].join('; ');
    expect(execFileSync(pwsh, ['-NoProfile', '-c', check], { encoding: 'utf8', env }).trim()).toBe('ok');
  });

  // Windows PowerShell 5.1 compiles Add-Type code with the .NET Framework C# 5 compiler; mcs checks the same language level.
  it.skipIf(!hasMcs)('compiles as C# 5 against System.Drawing', () => {
    const file = join(dir, 'computer.cs');
    writeFileSync(file, CSHARP);
    execFileSync('mcs', ['-langversion:5', '-target:library', '-nowarn:169,414,649', '-r:System.Drawing.dll', `-out:${join(dir, 'computer.dll')}`, file], { stdio: 'pipe' });
  });

  /** The real PowerShell loop around a stand-in for the Win32 class: JSON lines, arrays, flags, errors, Unicode. */
  const STUB = String.raw`
using System;
using System.Collections.Generic;
public static class PocketComputer {
  static List<string> keys = new List<string>();
  static string J(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r") + "\""; }
  static string A(int[] a) { if (a == null) return "null"; string[] p = new string[a.Length]; for (int i = 0; i < a.Length; i++) p[i] = a[i].ToString(); return "[" + string.Join(",", p) + "]"; }
  static string T(string s) { return "{\"text\":" + J(s) + "}"; }
  public static void Init() { }
  public static string Screenshot(int display, int maxW, int maxH) { return T("screenshot " + display + " " + maxW + "x" + maxH); }
  public static string Zoom(int x, int y, int w, int h, int maxW, int maxH) { return T("zoom " + x + "," + y + " " + w + "x" + h + " max " + maxW + "x" + maxH); }
  public static string Move(int x, int y) { return "{\"cursor\":{\"x\":" + x + ",\"y\":" + y + "}}"; }
  public static string Click(int x, int y, bool at, string button, int count, int[] mods) { return T("click " + x + "," + y + " at=" + at + " " + button + " x" + count + " mods=" + A(mods)); }
  public static string Button(string button, bool down) { return T("button " + button + " " + down); }
  public static string Drag(int[] path, string button) { return T("drag " + A(path) + " " + button); }
  public static string Scroll(int x, int y, bool at, int dx, int dy, int[] mods) { return T("scroll " + x + "," + y + " at=" + at + " " + dx + "," + dy + " mods=" + A(mods)); }
  public static string TypeText(string text) { return T("type " + text); }
  public static string Keys(int[] codes, int holdMs) { keys.Add(A(codes) + "/" + holdMs); return T("keys " + string.Join(" ", keys.ToArray())); }
  public static string Cursor() { return "{\"cursor\":{\"x\":3,\"y\":4}}"; }
  public static string Windows() { return "{\"windows\":[{\"handle\":\"7\",\"title\":\"Windows PowerShell\",\"process\":\"powershell\",\"x\":0,\"y\":0,\"width\":10,\"height\":10,\"minimized\":false,\"maximized\":false,\"focused\":true}]}"; }
  public static string Window(long handle, string what) { if (handle == 1) throw new ArgumentException("That window no longer exists"); return T("window " + handle + " " + what); }
  public static string Open(string target, string args) { return T("open " + target + " [" + args + "]"); }
  public static string ReleaseAll() { keys.Clear(); return T("released"); }
}
`;

  it.skipIf(!hasPwsh)('runs steps through the PowerShell loop', async () => {
    const file = join(dir, 'computer-stub.ps1');
    // The stub needs no System.Drawing; in PowerShell 7 naming it would also drop the default references.
    const head = COMPUTER_PS.slice(0, CS_START).replace(/^Add-Type -AssemblyName System\.Drawing$/m, '').replace('-ReferencedAssemblies System.Drawing ', '');
    writeFileSync(file, head + STUB + COMPUTER_PS.slice(CS_END));
    const host = new ComputerHost({ script: file, log: () => {}, shell: { command: pwsh, args: ['-NoProfile', '-NonInteractive', '-File'] } });
    const text = async (p: ReturnType<typeof host.act>) => (await p).text;
    try {
      expect(await text(host.act({ action: 'screenshot' }))).toBe('screenshot -1 1280x800');
      expect(await text(host.act({ action: 'screenshot', display: 1 }))).toBe('screenshot 1 1280x800');
      expect(await text(host.act({ action: 'click', x: 10, y: -20, button: 'right', count: 1, modifiers: ['ctrl'] }))).toBe('click 10,-20 at=True right x1 mods=[17]');
      expect(await text(host.act({ action: 'click', button: 'left', count: 3 }))).toBe('click 0,0 at=False left x3 mods=[]');
      expect(await text(host.act({ action: 'drag', path: [[1, 2], [30, 40], [50, 60]] }))).toBe('drag [1,2,30,40,50,60] left');
      expect(await text(host.act({ action: 'scroll', x: 5, y: 6, dx: 0, dy: 3, modifiers: ['shift', 'ctrl'] }))).toBe('scroll 5,6 at=True 0,3 mods=[16,17]');
      expect(await text(host.act({ action: 'type', text: 'Привет "мир"\ndir' }))).toBe('type Привет "мир"\ndir');
      expect(await text(host.act({ action: 'key', keys: 'ctrl+c Return', holdMs: 0 }))).toBe('keys [17,67]/0 [13]/0');
      expect(await host.act({ action: 'move', x: -1920, y: 15 })).toEqual({ cursor: { x: -1920, y: 15 } });
      expect((await host.act({ action: 'windows' })).windows?.[0]).toMatchObject({ handle: '7', title: 'Windows PowerShell', focused: true });
      expect(await text(host.act({ action: 'window', handle: '1312', op: 'focus' }))).toBe('window 1312 focus');
      await expect(host.act({ action: 'window', handle: '1', op: 'close' })).rejects.toThrow('That window no longer exists');
      expect(await text(host.act({ action: 'open', target: 'chrome', args: 'https://example.com' }))).toBe('open chrome [https://example.com]');
      expect(await text(host.act({ action: 'release' }))).toBe('released');
    } finally {
      host.close();
    }
  }, 60_000);
});
