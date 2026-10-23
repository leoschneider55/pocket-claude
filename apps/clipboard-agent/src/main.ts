import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parsePairingCode, parsePairingUri, serializeIdentity, type PairingCode } from '@pocket/protocol';
import { joinAccount, type WebSocketCtor } from '@pocket/transport';
import WebSocket from 'ws';
import { ClipboardAgent, type AgentState } from './agent.js';
import { macClipboard, windowsClipboard } from './clipboard.js';
import { COMPUTER_PS, ComputerHost } from './computer.js';
import { OverlayModel } from './overlay/model.js';
import { OVERLAY_PS_FILE } from './overlay/script.js';
import { OverlayWindow } from './overlay/window.js';
import { windowsScreen } from './screenshot.js';

const WS = WebSocket as unknown as WebSocketCtor;
const DEFAULT_RELAY = 'https://trunks-fineness-grumbling.ngrok-free.dev';
const APP = 'PocketClipboard';
const win = process.platform === 'win32';
const home = win ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), APP) : path.join(os.homedir(), '.pocket-clipboard');
const files = {
  state: path.join(home, 'state.json'),
  log: path.join(home, 'agent.log'),
  exe: path.join(home, `${APP}.exe`),
  vbs: path.join(home, 'start-hidden.vbs'),
  overlay: path.join(home, 'overlay.ps1'),
  computer: path.join(home, 'computer.ps1'),
};
const user = (os.userInfo().username || 'user').replace(/[^\w.-]/g, '_');
const pipe = win ? `\\\\.\\pipe\\pocket-clipboard-${user}` : path.join(os.tmpdir(), `pocket-clipboard-${user}.sock`);
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function log(msg: string): void {
  try {
    mkdirSync(home, { recursive: true });
    if (existsSync(files.log) && statSync(files.log).size > 1_000_000) renameSync(files.log, `${files.log}.1`);
    appendFileSync(files.log, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
  if (process.stdout.isTTY) console.log(msg);
}

function loadState(): AgentState | undefined {
  try {
    return JSON.parse(readFileSync(files.state, 'utf8')) as AgentState;
  } catch {
    return undefined;
  }
}

function saveState(state: AgentState): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(`${files.state}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${files.state}.tmp`, files.state);
}

/** The overlay exists on Windows only; there it is on unless switched off. */
const overlayWanted = (state: AgentState) => win && state.overlay !== false;

/** Asks the running background copy to do something; resolves undefined if none is running. */
function control(cmd: 'quit' | 'status' | 'overlay on' | 'overlay off'): Promise<string | undefined> {
  return new Promise((resolve) => {
    const s = net.createConnection(pipe);
    let out = '';
    s.on('connect', () => s.write(`${cmd}\n`));
    s.on('data', (d) => (out += d.toString()));
    s.on('end', () => resolve(out.trim()));
    s.on('error', () => resolve(undefined));
  });
}

async function pair(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nPair this computer with the phone.');
    console.log('On the phone: open a chat, tap the phone icon, then "Add a computer". Paste the link it shows (or just the code).\n');
    const pasted = (await rl.question('Link or code from the phone: ')).trim();
    let relay = DEFAULT_RELAY;
    let code: PairingCode;
    if (/^pocketclaude:\/\//i.test(pasted)) {
      const parsed = parsePairingUri(pasted);
      relay = parsed.relayUrl;
      code = parsed.code;
    } else {
      code = parsePairingCode(pasted);
      relay = (await rl.question(`Relay address [${DEFAULT_RELAY}]: `)).trim() || DEFAULT_RELAY;
    }
    const joined = await joinAccount({
      relayUrl: relay,
      code,
      role: 'executor',
      name: os.hostname(),
      WebSocket: WS,
      confirmSafetyNumber: async (n) => !(await rl.question(`Safety number ${n} (the phone shows the same one). Press Enter to continue, or type n to stop: `)).trim().toLowerCase().startsWith('n'),
    });
    saveState({
      relayUrl: relay,
      accountId: joined.reply.accountId,
      brainDeviceId: joined.reply.brainDeviceId,
      brainEncPub: joined.bundle.brainEncPub,
      deviceId: joined.deviceId,
      identity: serializeIdentity(joined.identity),
      replay: {},
    });
    console.log('Paired.');
    return true;
  } catch (e) {
    console.error(`Pairing failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {
  removeOldExes();
  const state = loadState();
  if (!state) {
    log('not paired; run "PocketClipboard.exe pair"');
    process.exit(1);
  }
  if (!win) rmSync(pipe, { force: true });
  let agent: ClipboardAgent | undefined;
  let computerHost: ComputerHost | undefined;
  let overlay: { model: OverlayModel; window: OverlayWindow } | undefined;
  const startOverlay = () => {
    if (overlay || !win) return;
    writeFileSync(files.overlay, OVERLAY_PS_FILE);
    const model = new OverlayModel({ window: (op) => void overlay?.window.send(op), request: (body) => agent?.request(body) }, state.overlayTheme);
    const window = new OverlayWindow({
      script: files.overlay,
      snapshot: () => model.snapshot(),
      log,
      onEvent: (e) => {
        if (e.ev === 'open') return model.open(e.id);
        if (e.ev === 'send') return model.send(e.chatId, e.text);
        if (e.ev === 'watch') return model.toggleWatch();
        if (e.ev !== 'theme' || e.theme === state.overlayTheme) return;
        state.overlayTheme = e.theme;
        saveState(state);
        model.setTheme(e.theme);
      },
    });
    overlay = { model, window };
    window.start();
    agent?.setOverlay(model);
  };
  const stopOverlay = () => {
    if (!overlay) return;
    agent?.setOverlay(undefined);
    overlay.window.close();
    overlay = undefined;
  };
  const server = net.createServer((s) => {
    s.on('data', (d) => {
      const cmd = d.toString().trim();
      if (cmd === 'status') s.end(`running, paired with account ${state.accountId}, overlay ${overlay ? 'on' : 'off'}\n`);
      if (cmd === 'quit') {
        s.end('bye\n');
        shutdown();
      }
      if (cmd === 'overlay on' || cmd === 'overlay off') {
        state.overlay = cmd === 'overlay on';
        saveState(state);
        if (state.overlay) startOverlay();
        else stopOverlay();
        s.end(`overlay ${overlay ? 'on' : 'off'}\n`);
      }
    });
    s.on('error', () => {});
  });
  server.once('error', () => {
    log('already running');
    process.exit(0);
  });
  server.listen(pipe, () => {
    if (win) {
      writeFileSync(files.computer, COMPUTER_PS);
      computerHost = new ComputerHost({ script: files.computer, log });
    }
    agent = new ClipboardAgent(state, {
      clipboard: win ? windowsClipboard : macClipboard,
      screen: win ? windowsScreen : undefined,
      computer: state.computer ? computerHost : undefined,
      watch: computerHost,
      WebSocket: WS,
      log,
      onRelayMoved: (url) => {
        state.relayUrl = url;
        saveState(state);
        log(`relay moved to ${url}`);
      },
    });
    if (overlayWanted(state)) startOverlay();
    agent.connect();
    log(`started (${process.pid}${overlay ? ', overlay on' : ''})`);
  });
  const persist = setInterval(() => {
    if (!agent) return;
    state.replay = agent.replayState();
    saveState(state);
  }, 30_000);
  const shutdown = () => {
    clearInterval(persist);
    stopOverlay();
    computerHost?.close();
    if (agent) {
      state.replay = agent.replayState();
      saveState(state);
      agent.close();
    }
    server.close();
    log('stopped');
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function startHidden(): void {
  if (win) spawn('wscript.exe', [files.vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'run'], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * A running copy keeps its exe locked, but Windows still lets a locked exe be renamed. So the old file is moved
 * aside (removed on the next start) and the new one copied in; running copies are asked to quit first.
 */
async function replaceExe(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      copyFileSync(process.execPath, files.exe);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw e;
      if (i === 1) {
        spawnSync('taskkill', ['/F', '/FI', `IMAGENAME eq ${APP}.exe`, '/FI', `PID ne ${process.pid}`], { stdio: 'ignore', windowsHide: true });
      } else if (i >= 2) {
        renameSync(files.exe, `${files.exe}.old-${Date.now()}`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  copyFileSync(process.execPath, files.exe);
}

/** Old executables moved aside by an update; they can be deleted once nothing runs them. */
function removeOldExes(): void {
  try {
    for (const f of readdirSync(home)) if (f.startsWith(`${APP}.exe.old-`)) rmSync(path.join(home, f), { force: true });
  } catch {}
}

async function install(): Promise<void> {
  if (!win) throw new Error('install is for Windows');
  mkdirSync(home, { recursive: true });
  await control('quit');
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(files.exe).toLowerCase()) await replaceExe();
  writeFileSync(files.vbs, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${files.exe}"" run", 0, False\r\n`);
  spawnSync('reg', ['add', RUN_KEY, '/v', APP, '/t', 'REG_SZ', '/d', `wscript.exe "${files.vbs}"`, '/f'], { stdio: 'ignore', windowsHide: true });
  console.log(`Installed to ${home} and set to start with Windows.`);
  if (!loadState() && !(await pair())) return;
  startHidden();
  console.log('Running in the background. The phone can now use this clipboard.');
}

async function uninstall(): Promise<void> {
  await control('quit');
  if (win) spawnSync('reg', ['delete', RUN_KEY, '/v', APP, '/f'], { stdio: 'ignore', windowsHide: true });
  rmSync(files.vbs, { force: true });
  rmSync(files.state, { force: true });
  console.log(`Removed autostart and pairing. You can delete ${home}.`);
}

async function pause(): Promise<void> {
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('\nPress Enter to close.');
  rl.close();
}

/** In a single executable argv[1] repeats the executable path; under plain node it is the script. */
function args(): string[] {
  const rest = process.argv.slice(1);
  if (rest[0] && (path.resolve(rest[0]) === path.resolve(process.execPath) || /\.(c?js|ts)$/.test(rest[0]))) rest.shift();
  return rest;
}

async function main(): Promise<void> {
  const [cmd] = args();
  switch (cmd ?? (process.stdin.isTTY ? 'install' : 'run')) {
    case 'run':
      return run();
    case 'pair': {
      // A running agent saves its state on exit, so it has to be gone before the new pairing is written.
      const wasRunning = (await control('quit')) !== undefined;
      if ((await pair()) || wasRunning) startHidden();
      return pause();
    }
    case 'install':
      await install().catch((e: unknown) => console.error(e instanceof Error ? e.message : String(e)));
      return pause();
    case 'uninstall':
      return uninstall();
    case 'stop':
      console.log((await control('quit')) ? 'Stopped.' : 'Not running.');
      return;
    case 'status':
      console.log((await control('status')) ?? (loadState() ? 'Paired, not running.' : 'Not paired.'));
      return;
    case 'overlay': {
      const on = args()[1];
      const state = loadState();
      if (on !== 'on' && on !== 'off') return console.log('Usage: PocketClipboard.exe overlay on|off');
      if (!state) return console.log('Not paired.');
      state.overlay = on === 'on';
      saveState(state);
      const applied = await control(`overlay ${on}`);
      console.log(`Overlay ${on}.${applied ? '' : ' Applies when the agent starts.'}`);
      return;
    }
    case 'computer': {
      const on = args()[1];
      if (on !== 'on' && on !== 'off') return console.log('Usage: PocketClipboard.exe computer on|off');
      // A running agent saves its state on exit, so it stops before the switch is written and starts again after.
      const wasRunning = (await control('quit')) !== undefined;
      const state = loadState();
      if (!state) return console.log('Not paired.');
      state.computer = on === 'on';
      saveState(state);
      if (wasRunning) startHidden();
      console.log(on === 'on' ? 'Computer use on: Claude may use the mouse, keyboard and windows here after you allow it on the phone.' : 'Computer use off.');
      return;
    }
    default:
      console.log('Usage: PocketClipboard.exe [install | pair | run | status | stop | uninstall | overlay on|off | computer on|off]');
  }
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
