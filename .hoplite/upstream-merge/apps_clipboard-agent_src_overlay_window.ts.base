import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { OverlayTheme, WindowOp } from './model.js';

export type WindowEvent =
  | { ev: 'ready' }
  | { ev: 'visible'; visible: boolean }
  | { ev: 'copied'; what: string }
  | { ev: 'theme'; theme: OverlayTheme }
  /** A chat was picked in the window's side list. */
  | { ev: 'open'; id: string }
  /** The user wrote a message to the chat on screen. */
  | { ev: 'send'; chatId: string; text: string }
  | { ev: 'error'; message: string };

export interface OverlayWindowOptions {
  /** PowerShell script to run; the caller writes it to disk. */
  script: string;
  /** Full redraw sent to every fresh window process. */
  snapshot: () => WindowOp;
  log: (m: string) => void;
  onEvent?: (e: WindowEvent) => void;
  spawn?: typeof nodeSpawn;
  /** Interpreter and its leading arguments; the script path is appended. Defaults to Windows PowerShell 5.1. */
  shell?: { command: string; args: string[] };
}

const POWERSHELL = { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File'] };
const MAX_CRASHES = 5;
const HEALTHY_MS = 60_000;

/** Runs the window process and keeps it alive: ops go in as JSON lines on stdin, events come back on stdout. */
export class OverlayWindow {
  private child: ChildProcess | undefined;
  private stopped = false;
  private crashes = 0;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: OverlayWindowOptions) {}

  start(): void {
    if (this.child || this.stopped) return;
    const spawn = this.opts.spawn ?? nodeSpawn;
    const shell = this.opts.shell ?? POWERSHELL;
    const child = spawn(shell.command, [...shell.args, this.opts.script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.startedAt = Date.now();
    child.on('error', (e) => this.opts.log(`overlay: ${e.message}`));
    child.stdin?.on('error', () => {});
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    if (child.stderr) createInterface({ input: child.stderr }).on('line', (line) => line.trim() && this.opts.log(`overlay: ${line.trim()}`));
    child.on('exit', (code) => this.onExit(code));
    this.send(this.opts.snapshot());
  }

  send(op: WindowOp): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(op)}\n`);
    return true;
  }

  close(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    this.send({ op: 'quit' });
    const killer = setTimeout(() => child.kill(), 2000);
    child.once('exit', () => clearTimeout(killer));
  }

  private onLine(line: string): void {
    let ev: WindowEvent;
    try {
      ev = JSON.parse(line) as WindowEvent;
    } catch {
      this.opts.log(`overlay: ${line}`);
      return;
    }
    if (ev.ev === 'error') this.opts.log(`overlay error: ${ev.message}`);
    this.opts.onEvent?.(ev);
  }

  private onExit(code: number | null): void {
    this.child = undefined;
    if (this.stopped) return;
    this.crashes = Date.now() - this.startedAt > HEALTHY_MS ? 1 : this.crashes + 1;
    if (this.crashes > MAX_CRASHES) {
      this.opts.log(`overlay window keeps exiting (code ${code}); giving up until the agent restarts`);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** (this.crashes - 1));
    this.opts.log(`overlay window exited (code ${code}); restarting in ${delay} ms`);
    this.restartTimer = setTimeout(() => this.start(), delay);
  }
}
