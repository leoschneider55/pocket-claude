import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { fileStore, PocketBot } from '@pocket/telegram-bot';
import qrcode from 'qrcode-terminal';
import { WebSocket as NodeWebSocket } from 'ws';
import type { WebSocketCtor } from '@pocket/transport';
import { maskApiKey, readApiKey, removeApiKey, saveApiKey } from './api-key.js';
import { Brain, type BrainStatus, type PairingTicket, type UserSummary } from './daemon.js';
import { log, logToStderr } from './log.js';
import { ensureDirs, loadOrCreateIdentity, loadState, paths, saveState } from './store.js';

type Request =
  | { cmd: 'status' }
  | { cmd: 'pair' }
  | { cmd: 'invite'; name?: string }
  | { cmd: 'users' }
  | { cmd: 'users.remove'; user: string }
  | { cmd: 'remove'; deviceId: string }
  | { cmd: 'kill' }
  | { cmd: 'allow.list' }
  | { cmd: 'allow.add'; rule: string }
  | { cmd: 'allow.remove'; rule: string }
  | { cmd: 'relay.move'; url: string }
  | { cmd: 'telegram.set'; config: { token: string; username: string } | null }
  | { cmd: 'telegram.app'; url: string | null }
  | { cmd: 'stop' };

type Response = { ok: true; data?: unknown } | { ok: false; error: string };

function resolveClaude(): string | undefined {
  if (process.env.POCKET_CLAUDE_PATH) return process.env.POCKET_CLAUDE_PATH;
  try {
    return execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function runDaemon(): Promise<void> {
  ensureDirs();
  logToStderr(process.stderr.isTTY ?? false);
  const state = loadState();
  if (process.env.POCKET_RELAY_URL) state.relayUrl = process.env.POCKET_RELAY_URL;
  const identity = await loadOrCreateIdentity();
  const claudePath = resolveClaude();
  const brain = new Brain(identity, state, { claudeOptions: claudePath ? { pathToClaudeCodeExecutable: claudePath } : {} });
  log(`brain ${brain.deviceId} account ${brain.accountId} relay ${state.relayUrl} claude ${claudePath ?? 'bundled'}`);

  if (existsSync(paths.socket)) unlinkSync(paths.socket);
  const telegram = new TelegramRunner(brain, state.relayUrl);
  const server = createServer((socket) => handleControl(socket, brain, telegram, () => shutdown()));
  server.listen(paths.socket);

  const shutdown = async () => {
    log('shutting down');
    server.close();
    await telegram.stop();
    brain.stop();
    if (existsSync(paths.socket)) unlinkSync(paths.socket);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  brain.start();
  telegram.apply();
}

/** Runs the Telegram bot inside the daemon while a token is configured; the bot talks to the brain through the relay like a phone. */
class TelegramRunner {
  private bot: PocketBot | undefined;
  private token: string | undefined;

  /** `relayUrl` is the daemon's own (local) relay address: the bot runs on the same machine and must not go through the public one. */
  constructor(
    private readonly brain: Brain,
    private readonly relayUrl: string,
  ) {}

  /** Starts, restarts or stops the bot to match the brain's configuration. */
  apply(): void {
    const config = this.brain.telegram;
    const key = config && `${config.token} ${config.appUrl ?? ''}`;
    if (key === this.token) return;
    void this.stop().then(() => {
      if (!config) return;
      this.token = key;
      const bot = new PocketBot({
        token: config.token,
        relayUrl: this.relayUrl,
        ...(config.appUrl ? { appUrl: config.appUrl } : {}),
        store: fileStore(join(paths.home, 'telegram.json')),
        log,
        WebSocket: NodeWebSocket as unknown as WebSocketCtor,
      });
      this.bot = bot;
      bot.start().catch((e) => {
        log(`telegram bot stopped: ${e instanceof Error ? e.message : String(e)}`);
        if (this.bot === bot) this.bot = undefined;
      });
    });
  }

  async stop(): Promise<void> {
    const bot = this.bot;
    this.bot = undefined;
    this.token = undefined;
    await bot?.stop().catch(() => {});
  }
}

function handleControl(socket: Socket, brain: Brain, telegram: TelegramRunner, shutdown: () => void): void {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString();
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const reply = (r: Response) => socket.end(`${JSON.stringify(r)}\n`);
    try {
      const req = JSON.parse(buf.slice(0, nl)) as Request;
      switch (req.cmd) {
        case 'status':
          return reply({ ok: true, data: brain.status() });
        case 'pair':
          return reply({ ok: true, data: brain.startPairing() });
        case 'invite':
          return reply({ ok: true, data: brain.startPairing(undefined, { invite: req.name ? { name: req.name } : {} }) });
        case 'users':
          return reply({ ok: true, data: brain.users() });
        case 'users.remove':
          return reply(brain.removeUser(req.user) ? { ok: true } : { ok: false, error: 'No such person (the owner cannot be removed)' });
        case 'remove':
          return reply(brain.removeDevice(req.deviceId) ? { ok: true } : { ok: false, error: 'No such device' });
        case 'kill':
          brain.kill();
          return reply({ ok: true });
        case 'relay.move':
          return reply({ ok: true, data: brain.movePublicRelay(req.url) });
        case 'telegram.set':
          brain.configureTelegram(req.config);
          telegram.apply();
          return reply({ ok: true });
        case 'telegram.app': {
          const url = brain.configureTelegramApp(req.url);
          telegram.apply();
          return reply({ ok: true, data: url });
        }
        case 'allow.list':
          return reply({ ok: true, data: brain.allowlist() });
        case 'allow.add': {
          const error = brain.addAllowRule(req.rule);
          return reply(error ? { ok: false, error } : { ok: true, data: brain.allowlist() });
        }
        case 'allow.remove':
          return reply(brain.removeAllowRule(req.rule) ? { ok: true, data: brain.allowlist() } : { ok: false, error: 'No such rule' });
        case 'stop':
          reply({ ok: true });
          setTimeout(shutdown, 50);
          return;
      }
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

function request(req: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(paths.socket);
    let buf = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on('data', (d) => (buf += d.toString()));
    socket.on('end', () => resolve(JSON.parse(buf) as Response));
    socket.on('error', () => reject(new Error('The pocket-claude daemon is not running. Start it with: pocket-claude daemon')));
  });
}

async function call<T>(req: Request): Promise<T> {
  const res = await request(req);
  if (!res.ok) throw new Error(res.error);
  return res.data as T;
}

function printStatus(s: BrainStatus): void {
  const dot = (b: boolean) => (b ? '●' : '○');
  console.log(`Relay      ${dot(s.relayConnected)} ${s.relayUrl}`);
  console.log(`Claude     ${s.claudeVersion ?? 'not found'}`);
  console.log(`Windows    ${dot(s.executorOnline)} ${s.workspaces.join(', ') || '(no workspace)'}`);
  console.log(`Account    ${s.accountId}`);
  console.log('Devices');
  if (!s.devices.length) console.log('  (none — run: pocket-claude pair)');
  for (const d of s.devices) console.log(`  ${dot(d.online)} ${d.role.padEnd(8)} ${d.name}  ${d.user}  ${d.deviceId}`);
  console.log(`Sessions   ${s.sessions.length}`);
}

function printUsers(users: UserSummary[]): void {
  const dot = (b: boolean) => (b ? '●' : '○');
  for (const u of users) {
    console.log(`${u.name}${u.owner ? ' (owner)' : ''}  id ${u.id}  ${u.sessions} chat${u.sessions === 1 ? '' : 's'}`);
    for (const d of u.devices) console.log(`  ${dot(d.online)} ${d.role.padEnd(8)} ${d.name}  ${d.deviceId}`);
    if (!u.devices.length) console.log('  (no devices)');
  }
}

function printTicket(t: PairingTicket): void {
  if (t.invite) {
    console.log('Invite: the new person scans this QR code in the Pocket Claude app (or opens the link) and enters their name.\n');
    qrcode.generate(t.uri, { small: true });
    console.log(`\n  link  ${t.uri}\n  safety number  ${t.safetyNumber}`);
    console.log(`\nValid until ${new Date(t.expiresAt).toLocaleTimeString()}. Their computers are added from their phone afterwards.`);
    return;
  }
  console.log('Phone: scan this QR code in the Pocket Claude app\n');
  qrcode.generate(t.uri, { small: true });
  console.log(`\nWindows (VS Code → "Pocket Claude: Pair with Mac"):\n  code           ${t.code}\n  safety number  ${t.safetyNumber}`);
  console.log(`\nValid until ${new Date(t.expiresAt).toLocaleTimeString()}. The code works for one phone and one Windows laptop.`);
}

/**
 * `pocket-claude telegram app [url|off]`: where the bot's menu button and `/app` open the Mini App. Without a URL
 * the public relay address is used, because the Node relay serves the exported web app itself.
 */
async function telegramApp(arg: string | undefined): Promise<void> {
  const state = loadState();
  let url: string | null;
  if (arg === 'off') url = null;
  else if (arg) url = new URL(arg).toString();
  else {
    if (!state.publicRelayUrl) throw new Error('No public relay address yet: pocket-claude relay <https url>, or pass the Mini App URL explicitly');
    url = `${state.publicRelayUrl}/`;
  }
  if (url && !url.startsWith('https://')) throw new Error('Telegram opens Mini Apps over https only');
  const done = (u: string | null) =>
    console.log(u ? `Mini App: ${u}\nIn Telegram the bot's menu button opens it; /app pairs it with one tap. Build it with: pnpm --filter @pocket/mobile export:web` : 'Mini App button removed.');
  try {
    return done(await call<string | null>({ cmd: 'telegram.app', url }));
  } catch (e) {
    if (e instanceof Error && !/not running/.test(e.message)) throw e;
    if (!state.telegram) throw new Error('Set up the bot first: pocket-claude telegram <token>');
    if (url) state.telegram.appUrl = url;
    else delete state.telegram.appUrl;
    saveState(state);
    console.log('Daemon not running; applied on start.');
    return done(url);
  }
}

/** Checks the token with Telegram and returns the bot's username. */
async function telegramGetMe(token: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const body = (await res.json()) as { ok: boolean; result?: { username?: string }; description?: string };
  if (!body.ok || !body.result?.username) throw new Error(body.description ?? 'Telegram rejected the token');
  return body.result.username;
}

function printUsage(days: number): void {
  const state = loadState();
  const usage = state.usage ?? { days: {}, sessions: {} };
  const money = (n: number) => `$${n.toFixed(2)}`;
  const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const recent = Object.entries(usage.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, days);
  if (!recent.length) return console.log('No usage recorded yet.');
  console.log('Day          turns   cost      in        out');
  for (const [day, u] of recent) {
    console.log(`${day}   ${String(u.turns).padStart(5)}   ${money(u.costUsd).padStart(7)}   ${tokens(u.inputTokens).padStart(7)}   ${tokens(u.outputTokens).padStart(7)}`);
  }
  const titles = new Map(state.sessions.map((s) => [s.sessionId, s.title]));
  const top = Object.entries(usage.sessions).sort(([, a], [, b]) => b.costUsd - a.costUsd).slice(0, 5);
  console.log('\nTop chats by cost');
  for (const [id, u] of top) console.log(`  ${money(u.costUsd).padStart(7)}  ${u.turns} turns  ${titles.get(id) ?? id}`);
  console.log('\nCosts are what Claude Code reports; on a subscription they show usage, not money charged.');
}

function searchHistory(query: string): void {
  const needle = query.toLowerCase();
  const state = loadState();
  let hits = 0;
  for (const meta of [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    let lines: string[];
    try {
      lines = readFileSync(join(paths.sessionsDir, `${meta.sessionId}.jsonl`), 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line) continue;
      const e = JSON.parse(line) as { kind: string; text?: string };
      if ((e.kind !== 'user' && e.kind !== 'text') || !e.text) continue;
      const at = e.text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 60);
      const snippet = e.text.slice(start, at + needle.length + 60).replace(/\s+/g, ' ');
      console.log(`${new Date(meta.updatedAt).toLocaleDateString()}  ${meta.title}  ${e.kind === 'user' ? 'you' : 'claude'}: …${snippet}…`);
      if (++hits >= 50) return;
    }
  }
  if (!hits) console.log('Nothing found.');
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'daemon':
      return runDaemon();
    case 'status':
      return printStatus(await call<BrainStatus>({ cmd: 'status' }));
    case 'pair':
      return printTicket(await call<PairingTicket>({ cmd: 'pair' }));
    case 'invite':
      return printTicket(await call<PairingTicket>({ cmd: 'invite', ...(arg ? { name: process.argv.slice(3).join(' ') } : {}) }));
    case 'users': {
      const [, sub, ...rest] = process.argv.slice(2);
      if (sub === 'remove' && rest.length) {
        await call({ cmd: 'users.remove', user: rest.join(' ') });
        return console.log('Removed with all their devices and chats.');
      }
      if (sub && sub !== 'list') throw new Error('Usage: pocket-claude users [list | remove <name or id>]');
      return printUsers(await call<UserSummary[]>({ cmd: 'users' }));
    }
    case 'remove':
      if (!arg) throw new Error('Usage: pocket-claude remove <deviceId>');
      await call({ cmd: 'remove', deviceId: arg });
      return console.log('Removed.');
    case 'kill':
      await call({ cmd: 'kill' });
      return console.log('Stopped all Claude sessions and Windows commands.');
    case 'stop':
      await call({ cmd: 'stop' });
      return console.log('Daemon stopped.');
    case 'allow': {
      const [, sub, ...rest] = process.argv.slice(2);
      const rule = rest.join(' ');
      let rules: string[];
      if (sub === 'add' && rule) rules = await call<string[]>({ cmd: 'allow.add', rule });
      else if (sub === 'remove' && rule) rules = await call<string[]>({ cmd: 'allow.remove', rule });
      else if (!sub || sub === 'list') rules = await call<string[]>({ cmd: 'allow.list' });
      else throw new Error('Usage: pocket-claude allow [list | add <rule> | remove <rule>]\n  rule: write_file | run_command:<command prefix>');
      return console.log(rules.length ? rules.map((r) => `  ${r}`).join('\n') : '  (empty — every write and command asks for approval)');
    }
    case 'api-key': {
      const sub = process.argv[3];
      if (sub === 'set') {
        // Read from stdin so the key never lands in shell history or the process list.
        ensureDirs();
        const key = process.stdin.isTTY ? await promptHidden('Anthropic API key: ') : readFileSync(0, 'utf8');
        saveApiKey(key);
        return console.log(`Saved ${maskApiKey(key.trim())}. Chats switched to the API ("switch to the API") bill it from their next reply.`);
      }
      if (sub === 'remove') {
        removeApiKey();
        return console.log('Removed. API-billed chats go back to the subscription on their next start.');
      }
      if (sub && sub !== 'status') throw new Error('Usage: pocket-claude api-key [status | set | remove]  (set reads the key from stdin)');
      const key = readApiKey();
      return console.log(key ? `API key ${maskApiKey(key)}` : 'No API key: pocket-claude api-key set');
    }
    case 'usage':
      return printUsage(Number(arg ?? 14));
    case 'search':
      if (!arg) throw new Error('Usage: pocket-claude search <text>');
      return searchHistory(process.argv.slice(3).join(' '));
    case 'telegram': {
      if (!arg) throw new Error('Usage: pocket-claude telegram <bot token from @BotFather> | off | app [https url | off]');
      if (arg === 'app') return telegramApp(process.argv[4]);
      const config = arg === 'off' ? null : { token: arg, username: await telegramGetMe(arg) };
      try {
        await call({ cmd: 'telegram.set', config });
        return console.log(config ? `Telegram bot @${config.username} is running. On the phone: Settings → Telegram → Link.` : 'Telegram bot stopped and forgotten.');
      } catch {
        ensureDirs();
        const state = loadState();
        if (config) state.telegram = config;
        else delete state.telegram;
        saveState(state);
        return console.log(config ? `Daemon not running; bot @${config.username} starts with it.` : 'Daemon not running; the bot is forgotten.');
      }
    }
    case 'relay': {
      if (!arg) throw new Error('Usage: pocket-claude relay <public url>');
      const url = new URL(arg).toString();
      try {
        const next = await call<string>({ cmd: 'relay.move', url });
        return console.log(`Public relay set to ${next}. Paired devices are switching over.`);
      } catch {
        ensureDirs();
        const state = loadState();
        state.publicRelayUrl = url.replace(/\/$/, '');
        saveState(state);
        return console.log(`Daemon not running; public relay set to ${state.publicRelayUrl}. Devices switch when it starts.`);
      }
    }
    default:
      console.log('Usage: pocket-claude <daemon|status|pair|invite [name]|users [remove <name>]|remove <deviceId>|kill|stop|relay <url>|telegram <token>|off|app [url]|allow ...|usage [days]|search <text>>');
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
