import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  b64,
  deriveAccountId,
  deriveDeviceId,
  newPairingCode,
  openPairRequest,
  PAIRING_TTL_MS,
  pairingUri,
  safetyNumber,
  sealPairReply,
  type ClipboardItem,
  type ComputerAction,
  type ComputerResult,
  type Identity,
  TOOL_NAMES,
  type InnerMessageBody,
  type MessageType,
  type ModelInfo,
  type PairingBundle,
  MAC_DEVICE_ID,
  type PairingCode,
  type Project,
  type PayloadOf,
  type PushHint,
  type RelayToDevice,
  type ScreenImage,
  type ScreenWatchFrame,
  type ScreenWatchSettings,
  type ScreenWatchStatus,
  type SessionEvent,
  type SessionMeta,
} from '@pocket/protocol';
import { DeviceLink, type IncomingMessage, type WebSocketCtor } from '@pocket/transport';
import { WebSocket as NodeWebSocket } from 'ws';
import { isAllowedByRules, validateRule } from './allowlist.js';
import { FALLBACK_MODELS } from './chat-tools.js';
import { COMPUTER_TOOL, computerConsent } from './computer-tools.js';
import { toDisplayCall } from './claude-tools.js';
import { ExecutorBridge } from './executor.js';
import { log } from './log.js';
import type { PcHandle } from './pc-tools.js';
import { PermissionBroker, SANDBOX_NETWORK_TOOL } from './permissions.js';
import { Session, type UserTurn } from './session.js';
import { WatchManager, type WatchDevice, type WatchScreenFrame } from './watch-manager.js';
import { migrateState, OWNER_ID, saveState, type BrainState, type PairedDevice, type UsageTotals, type User } from './store.js';

const MAX_LIVE_SESSIONS = 2;

const DELTA_FLUSH_MS = 60;
const CLIPBOARD_TIMEOUT_MS = 60_000;

/** A computer-use step may first wait for PocketClipboard to start its helper; typing and holding take longer still. */
function computerTimeout(action: ComputerAction): number {
  if (action.action === 'type') return 90_000 + action.text.length * 25;
  if (action.action === 'key') return 90_000 + (action.holdMs ?? 0);
  return 90_000;
}

type PcRequest = Extract<InnerMessageBody, { type: 'clipboard.read' | 'clipboard.write' | 'screen.capture' | 'computer.act' }>;
type PcReply = Extract<InnerMessageBody, { type: 'clipboard.data' | 'clipboard.done' | 'screen.image' | 'computer.done' }>;
type PcAnswer = ComputerResult & { items?: ClipboardItem[]; image?: ScreenImage; error?: string };
/** The only client traffic a computer with the 'overlay' capability gets to see: the chat itself, nothing it could act on. */
const OVERLAY_MIRRORED = new Set<MessageType>(['session.event', 'session.created', 'session.updated', 'session.deleted', 'screen.watch.status']);

type WatchUserTurn = UserTurn & {
  screenFrame?: WatchScreenFrame;
  observation?: { windowTitle: string; capturedAt: number; goal?: string };
};

export interface PairingTicket {
  code: string;
  uri: string;
  safetyNumber: string;
  expiresAt: number;
  /** The code registers a new person instead of adding a device to an existing one. */
  invite?: boolean;
}

export interface UserSummary extends User {
  devices: (Pick<PairedDevice, 'deviceId' | 'role' | 'name'> & { online: boolean })[];
  sessions: number;
}

export interface BrainStatus {
  accountId: string;
  deviceId: string;
  relayUrl: string;
  relayConnected: boolean;
  claudeVersion: string | null;
  executorOnline: boolean;
  workspaces: string[];
  devices: (Pick<PairedDevice, 'deviceId' | 'role' | 'name'> & { online: boolean; user: string })[];
  sessions: SessionMeta[];
}

/** An open pairing code. `userId` is set once the code belongs to a person; invites get one when the first device joins. */
interface OpenPairing {
  code: PairingCode;
  expiresAt: number;
  onPaired?: (d: PairedDevice) => void;
  userId?: string;
  invite?: { name?: string };
}

export class Brain {
  readonly deviceId: string;
  readonly accountId: string;
  private readonly link: DeviceLink;
  private readonly executor: ExecutorBridge;
  private readonly permissions: PermissionBroker;
  private readonly watch: WatchManager;
  private readonly sessions = new Map<string, Session>();
  private readonly pairings = new Map<string, OpenPairing>();
  private readonly pendingDeltas = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
  private claudeVersion: string | null = null;
  /** Clipboard and screen requests waiting for a computer's answer. */
  private readonly pcRequests = new Map<string, { deviceId: string; timer: ReturnType<typeof setTimeout>; resolve: (r: PcReply) => void }>();
  private models: ModelInfo[] | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly identity: Identity,
    private readonly state: BrainState,
    private readonly opts: { WebSocket?: WebSocketCtor; claudeOptions?: Partial<Options>; persist?: boolean } = {},
  ) {
    migrateState(state);
    this.deviceId = deriveDeviceId(identity.signPub);
    this.accountId = deriveAccountId(identity.signPub);
    this.link = new DeviceLink({
      relayUrl: state.relayUrl,
      accountId: this.accountId,
      deviceId: this.deviceId,
      role: 'brain',
      identity,
      peers: Object.fromEntries(state.devices.map((d) => [d.deviceId, d.encPub])),
      replayState: state.replay,
      WebSocket: opts.WebSocket ?? (NodeWebSocket as unknown as WebSocketCtor),
      log: (m) => log(`link: ${m}`),
    });
    this.executor = new ExecutorBridge({
      executorIds: () => this.executorDevices().map((d) => d.deviceId),
      isOnline: (id) => this.link.isOnline(id),
      send: (to, body) => this.link.send(to, body),
    });
    this.permissions = new PermissionBroker({
      isAllowedAlways: (tool, input) => isAllowedByRules(this.state.allowlist, tool, input),
      request: (p) => this.toClients(this.userOfSession(p.sessionId), { type: 'permission.request', payload: p }, 'permission'),
      resolved: (requestId, sessionId, decision, by) => this.toClients(this.userOfSession(sessionId), { type: 'permission.resolved', payload: { requestId, decision, by } }),
      waiting: (sessionId, waiting) => this.sessions.get(sessionId)?.setState(waiting ? 'waiting_permission' : 'running'),
    });
    this.watch = new WatchManager({
      session: (sessionId) => {
        const s = this.sessions.get(sessionId);
        return s ? { userId: this.userOfSession(sessionId), state: s.meta.state, busy: s.busy, watch: s.meta.watch } : undefined;
      },
      deviceForSession: (sessionId) => this.watchDeviceForSession(sessionId),
      canObserve: (sessionId) => {
        const s = this.sessions.get(sessionId);
        return !!s && s.meta.state === 'idle' && !s.busy && !this.permissions.outstanding().some((p) => p.sessionId === sessionId);
      },
      sendControl: (deviceId, payload) => this.link.send(deviceId, { type: 'screen.watch.control', payload }),
      sendCapture: (deviceId, payload) => this.link.send(deviceId, { type: 'screen.watch.capture', payload }),
      publish: (status) => this.publishWatchStatus(status),
      notice: (sessionId, text) => this.emitEvent(sessionId, { kind: 'screen_watch', at: Date.now(), text }, true),
      observe: (frame, context) => this.sendWatchObservation(frame, context),
    });
    for (const meta of state.sessions) {
      const restored = {
        ...meta,
        state: meta.state === 'ended' ? 'ended' : 'idle',
        ...(meta.watch && meta.watch.state !== 'off' ? { watch: { ...meta.watch, state: 'off' as const, reason: 'offline' as const } } : {}),
      } as SessionMeta;
      this.sessions.set(meta.sessionId, new Session(restored, this.sessionHost(), true));
    }

    this.link.on('message', (m) => void this.onMessage(m).catch((e) => log(`message handler failed: ${String(e)}`)));
    this.link.on('control', (f) => this.onControl(f));
    this.link.on('ready', (_roster, online) => {
      log(`relay ready; online: ${online.join(', ') || 'nobody'}`);
      this.broadcastStatus();
    });
    this.link.on('presence', (deviceId, online) => {
      const device = this.state.devices.find((d) => d.deviceId === deviceId);
      if (!device) return;
      log(`${device.role} ${device.name} is ${online ? 'online' : 'offline'}`);
      if (online && this.state.publicRelayUrl) this.link.send(deviceId, { type: 'relay.moved', payload: { url: this.state.publicRelayUrl } });
      if (device.role === 'executor') {
        if (!online) {
          this.watch.deviceOffline(deviceId);
          this.executor.failAll('The computer went offline.', deviceId);
        } else this.disableRestoredWatcher(deviceId);
        this.broadcastStatus(online ? undefined : 'executor_offline');
        this.broadcastComputers();
      } else if (online) {
        this.sendStatus(deviceId);
        for (const p of this.permissions.outstanding()) {
          if (this.userOfSession(p.sessionId) === device.userId) this.link.send(deviceId, { type: 'permission.request', payload: p });
        }
      }
    });
  }

  start(): void {
    this.link.connect();
    void this.detectClaudeVersion();
  }

  stop(): void {
    this.watch.shutdown();
    for (const s of this.sessions.values()) s.stop();
    this.persistNow();
    this.link.close();
  }

  status(): BrainStatus {
    return {
      accountId: this.accountId,
      deviceId: this.deviceId,
      relayUrl: this.publicRelayUrl,
      relayConnected: this.link.isReady,
      claudeVersion: this.claudeVersion,
      executorOnline: this.executor.online(this.defaultExecutor(OWNER_ID)),
      workspaces: this.executor.info(this.defaultExecutor(OWNER_ID))?.workspaces ?? [],
      devices: this.state.devices.map((d) => ({ deviceId: d.deviceId, role: d.role, name: d.name, online: this.link.isOnline(d.deviceId), user: this.userName(d.userId) })),
      sessions: [...this.sessions.values()].map((s) => s.meta),
    };
  }

  users(): UserSummary[] {
    return this.state.users.map((u) => ({
      ...u,
      devices: this.state.devices.filter((d) => d.userId === u.id).map((d) => ({ deviceId: d.deviceId, role: d.role, name: d.name, online: this.link.isOnline(d.deviceId) })),
      sessions: this.sortedSessions(u.id).length,
    }));
  }

  /** Removes a person with all their devices and chats. The owner cannot be removed. */
  removeUser(idOrName: string): boolean {
    const needle = idOrName.trim().toLowerCase();
    const user = this.state.users.find((u) => !u.owner && (u.id === needle || u.name.toLowerCase() === needle));
    if (!user) return false;
    for (const d of this.state.devices.filter((d) => d.userId === user.id)) this.removeDevice(d.deviceId);
    for (const s of [...this.sessions.values()].filter((s) => (s.meta.userId ?? OWNER_ID) === user.id)) {
      for (const p of this.permissions.outstanding()) if (p.sessionId === s.id) this.permissions.respond(p.requestId, 'deny', 'removed');
      this.watch.removeSession(s.id);
      s.destroy();
      this.sessions.delete(s.id);
    }
    if (this.state.activeExecutors) delete this.state.activeExecutors[user.id];
    this.state.users = this.state.users.filter((u) => u.id !== user.id);
    this.persistNow();
    log(`removed user "${user.name}" (${user.id})`);
    return true;
  }

  private isOwner(userId: string): boolean {
    return this.state.users.find((u) => u.id === userId)?.owner === true;
  }

  private userName(userId: string): string {
    return this.state.users.find((u) => u.id === userId)?.name ?? userId;
  }

  private userOf(deviceId: string): string | undefined {
    return this.state.devices.find((d) => d.deviceId === deviceId)?.userId;
  }

  private userOfSession(sessionId: string): string {
    return this.sessions.get(sessionId)?.meta.userId ?? OWNER_ID;
  }

  private permissionSession(requestId: string): string | undefined {
    return this.permissions.outstanding().find((p) => p.requestId === requestId)?.sessionId;
  }

  /**
   * Issues a one-time code. The phone scans `uri`; the Windows executor types `code` and checks `safetyNumber`.
   * Devices join the person in `userId` (the owner by default); an `invite` registers a new person with the first device.
   */
  startPairing(onPaired?: (d: PairedDevice) => void, opts: { userId?: string; invite?: { name?: string } } = {}): PairingTicket {
    if (!this.link.isReady) throw new Error('Not connected to the relay yet');
    const code = newPairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const bundle: PairingBundle = {
      v: 1,
      accountId: this.accountId,
      brainDeviceId: this.deviceId,
      brainSignPub: b64.encode(this.identity.signPub),
      brainEncPub: b64.encode(this.identity.encPub),
      expiresAt,
    };
    const invite = opts.invite !== undefined;
    this.pairings.set(code.pairingId, { code, expiresAt, onPaired, ...(invite ? { invite: opts.invite } : { userId: opts.userId ?? OWNER_ID }) });
    this.link.sendControl({ t: 'pairing.publish', pairingId: code.pairingId, bundle });
    setTimeout(() => this.pairings.delete(code.pairingId), PAIRING_TTL_MS + 5_000);
    return { code: code.display, uri: pairingUri(code, this.publicRelayUrl, { invite }), safetyNumber: safetyNumber(bundle), expiresAt, ...(invite ? { invite } : {}) };
  }

  get publicRelayUrl(): string {
    return this.state.publicRelayUrl ?? this.state.relayUrl;
  }

  /** Tells every device the relay's new public address. Offline devices hear it when they next come online through the old one. */
  movePublicRelay(url: string): string {
    const next = new URL(url).toString().replace(/\/$/, '');
    this.state.publicRelayUrl = next;
    this.persistNow();
    for (const d of this.state.devices) this.link.send(d.deviceId, { type: 'relay.moved', payload: { url: next } });
    log(`public relay is now ${next}`);
    return next;
  }

  /** Turns the Telegram bot on (token + username from getMe) or off; phones learn about it through the status. */
  configureTelegram(config: { token: string; username: string } | null): void {
    if (config) this.state.telegram = { ...config, ...(this.state.telegram?.appUrl ? { appUrl: this.state.telegram.appUrl } : {}) };
    else delete this.state.telegram;
    this.persistNow();
    this.broadcastStatus();
  }

  /** Where the bot sends people for the Mini App (`null` removes the menu button); needs a configured bot. */
  configureTelegramApp(url: string | null): string | null {
    if (!this.state.telegram) throw new Error('Set up the bot first: pocket-claude telegram <token>');
    if (url) this.state.telegram.appUrl = url;
    else delete this.state.telegram.appUrl;
    this.persistNow();
    return this.state.telegram.appUrl ?? null;
  }

  get telegram(): { token: string; username: string; appUrl?: string } | undefined {
    return this.state.telegram;
  }

  removeDevice(deviceId: string): boolean {
    const device = this.state.devices.find((d) => d.deviceId === deviceId);
    if (!device) return false;
    if (device.role === 'executor') this.watch.deviceRemoved(deviceId);
    this.state.devices = this.state.devices.filter((d) => d.deviceId !== deviceId);
    this.link.removePeer(deviceId);
    this.link.sendControl({ t: 'roster.remove', deviceId });
    if (device.role === 'executor') {
      this.executor.forget(deviceId);
      for (const [userId, active] of Object.entries(this.state.activeExecutors ?? {})) if (active === deviceId) delete this.state.activeExecutors![userId];
      this.broadcastComputers();
      this.broadcastStatus();
    }
    this.persistNow();
    return true;
  }

  /** Paired computers, optionally only one person's. */
  private executorDevices(userId?: string): PairedDevice[] {
    return this.state.devices.filter((d) => d.role === 'executor' && (userId === undefined || d.userId === userId));
  }

  /** A person's default computer for the clipboard: the one picked last, else the first online one, else any. */
  private defaultExecutor(userId: string): string | undefined {
    const all = this.executorDevices(userId);
    const active = this.state.activeExecutors?.[userId];
    if (all.some((d) => d.deviceId === active)) return active;
    const clip = all.filter((d) => this.executor.info(d.deviceId)?.capabilities?.includes('clipboard'));
    const pool = clip.length ? clip : all;
    return (pool.find((d) => this.link.isOnline(d.deviceId)) ?? pool[0])?.deviceId;
  }

  private setActiveExecutor(userId: string, deviceId: string): void {
    this.state.activeExecutors = { ...this.state.activeExecutors, [userId]: deviceId };
  }

  /** Old extensions don't report capabilities; they are tool executors. */
  private hasTools(deviceId: string): boolean {
    const caps = this.executor.info(deviceId)?.capabilities;
    return !caps || caps.includes('tools');
  }

  /** PocketClipboard with the overlay window: it mirrors the chat on screen, reads sessions, writes text into them and sets their model. */
  private isOverlay(deviceId: string): boolean {
    return !!this.executor.info(deviceId)?.capabilities?.includes('overlay');
  }

  /** Chats of people other than the owner that have no tools computer run on the Mac without any file access. */
  private chatOnly(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    return !this.isOwner(s.meta.userId ?? OWNER_ID) && this.executorForSession(sessionId) === undefined;
  }

  /** The PocketClipboard computer a chat's pc_* tools talk to: the chat's computer if it has one, else the person's default. */
  private pcForSession(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const userId = s.meta.userId ?? OWNER_ID;
    const hasClipboard = (id: string | undefined) => !!id && this.executorDevices(userId).some((d) => d.deviceId === id) && !!this.executor.info(id)?.capabilities?.includes('clipboard');
    if (hasClipboard(s.meta.executorId)) return s.meta.executorId;
    const fallback = this.defaultExecutor(userId);
    return hasClipboard(fallback) ? fallback : undefined;
  }

  /** Watching uses the chat's selected computer, or the person's current default when the chat has none. */
  private watchDeviceForSession(sessionId: string): WatchDevice | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const userId = this.userOfSession(sessionId);
    const selected = s.meta.executorId;
    const deviceId = selected ?? this.defaultExecutor(userId);
    const device = this.executorDevices(userId).find((d) => d.deviceId === deviceId);
    if (!device) return undefined;
    return {
      deviceId: device.deviceId,
      userId: device.userId,
      online: this.link.isOnline(device.deviceId),
      capabilities: this.executor.info(device.deviceId)?.capabilities ?? [],
    };
  }

  /** Where a chat runs: the Mac, a tools computer, or chat-only on the Mac without files (people with just PocketClipboard). */
  sessionMode(sessionId: string): { mode: 'mac' | 'remote' | 'chat'; executorId?: string; pcId?: string } | undefined {
    if (!this.sessions.has(sessionId)) return undefined;
    const executorId = this.executorForSession(sessionId);
    const pcId = this.pcForSession(sessionId);
    return { mode: executorId ? 'remote' : this.chatOnly(sessionId) ? 'chat' : 'mac', ...(executorId ? { executorId } : {}), ...(pcId ? { pcId } : {}) };
  }

  /** Sends a clipboard or screen request to a computer and waits for its answer. */
  private askPc(deviceId: string, body: PcRequest, timeoutMs = CLIPBOARD_TIMEOUT_MS): Promise<PcAnswer> {
    return new Promise((resolve) => {
      const { requestId } = body.payload;
      if (!this.link.isOnline(deviceId) || !this.link.send(deviceId, body)) return resolve({ error: 'The computer is offline' });
      const timer = setTimeout(() => {
        if (this.pcRequests.delete(requestId)) resolve({ error: 'The computer did not answer' });
      }, timeoutMs);
      this.pcRequests.set(requestId, { deviceId, timer, resolve: (r) => resolve(r.payload) });
    });
  }

  private pcHandle(sessionId: string): PcHandle {
    const id = () => this.pcForSession(sessionId);
    const ask = (body: PcRequest, timeoutMs?: number) => {
      const deviceId = id();
      return deviceId ? this.askPc(deviceId, body, timeoutMs) : Promise.resolve({ error: 'No computer' });
    };
    const self = this;
    return {
      get id() {
        return id();
      },
      get name() {
        const deviceId = id();
        return deviceId ? self.state.devices.find((d) => d.deviceId === deviceId)?.name : undefined;
      },
      get online() {
        return self.link.isOnline(id() ?? '');
      },
      get capabilities() {
        return self.executor.info(id())?.capabilities ?? [];
      },
      clipboardRead: () => ask({ type: 'clipboard.read', payload: { requestId: randomUUID() } }),
      clipboardWrite: (item) => ask({ type: 'clipboard.write', payload: { requestId: randomUUID(), item } }),
      screenshot: () => ask({ type: 'screen.capture', payload: { requestId: randomUUID() } }),
      computer: (action) => ask({ type: 'computer.act', payload: { requestId: randomUUID(), action } }, computerTimeout(action)),
      screenWatch: (enabled, goal, settings) => this.watch.set(sessionId, self.userOfSession(sessionId), { enabled, goal, settings }),
    };
  }

  /**
   * The computer a chat works on, or undefined for the Mac itself. Only the owner's chats work on the Mac:
   * other people's chats fall back to their default computer; without one they run on the Mac in chat-only mode.
   */
  private executorForSession(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    const userId = s.meta.userId ?? OWNER_ID;
    const mine = this.executorDevices(userId);
    const chosen = s.meta.executorId;
    if (chosen && mine.some((d) => d.deviceId === chosen) && this.hasTools(chosen)) return chosen;
    if (this.isOwner(userId)) return undefined;
    const tools = mine.filter((d) => this.hasTools(d.deviceId)).sort((a, b) => a.pairedAt - b.pairedAt);
    const active = this.state.activeExecutors?.[userId];
    return (tools.find((d) => d.deviceId === active) ?? tools[0])?.deviceId;
  }

  private macProjects(): Project[] {
    const used = new Map<string, number>();
    for (const s of this.sessions.values()) {
      if (s.meta.project && !this.executorForSession(s.id)) used.set(s.meta.project, Math.max(used.get(s.meta.project) ?? 0, s.meta.updatedAt));
    }
    const out = new Map<string, Project>();
    const add = (path: string, lastOpened?: number) => {
      if (out.has(path)) return;
      try {
        if (!statSync(path).isDirectory()) return;
      } catch {
        return;
      }
      out.set(path, { path, name: basename(path), open: false, ...(lastOpened ? { lastOpened } : {}) });
    };
    for (const [path, at] of [...used.entries()].sort((a, b) => b[1] - a[1])) add(path, at);
    const docs = join(homedir(), 'Documents');
    try {
      const repos = readdirSync(docs, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(docs, e.name, '.git')))
        .map((e) => ({ path: join(docs, e.name), at: statSync(join(docs, e.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const r of repos) add(r.path, Math.round(r.at));
    } catch {}
    return [...out.values()].slice(0, 30);
  }

  private computers(userId: string): PayloadOf<'computers.result'> {
    return {
      computers: this.executorDevices(userId).map((d) => {
        const info = this.executor.info(d.deviceId);
        return {
          deviceId: d.deviceId,
          name: d.name,
          online: this.link.isOnline(d.deviceId),
          ...(info?.os ? { os: info.os } : {}),
          workspaces: info?.workspaces ?? [],
          ...(info?.projects ? { projects: info.projects } : {}),
          ...(info?.capabilities ? { capabilities: info.capabilities } : {}),
          pairedAt: d.pairedAt,
        };
      }),
      activeId: this.defaultExecutor(userId) ?? null,
      ...(this.isOwner(userId) ? { mac: { name: hostname().replace(/\.local$/, ''), projects: this.macProjects() } } : {}),
    };
  }

  private broadcastComputers(): void {
    for (const u of this.state.users) {
      if (this.state.devices.some((d) => d.userId === u.id && d.role === 'client' && this.link.isOnline(d.deviceId))) {
        this.toClients(u.id, { type: 'computers.result', payload: this.computers(u.id) }, undefined, true);
      }
    }
  }

  allowlist(): string[] {
    return [...this.state.allowlist];
  }

  addAllowRule(rule: string): string | null {
    const error = validateRule(rule, [...TOOL_NAMES, COMPUTER_TOOL]);
    if (error) return error;
    if (!this.state.allowlist.includes(rule)) this.state.allowlist = [...this.state.allowlist, rule];
    this.persistNow();
    return null;
  }

  removeAllowRule(rule: string): boolean {
    const before = this.state.allowlist.length;
    this.state.allowlist = this.state.allowlist.filter((r) => r !== rule);
    this.persistNow();
    return this.state.allowlist.length !== before;
  }

  /** Stops everything, or everything of one person. */
  kill(userId?: string): void {
    log(userId ? `kill switch for ${this.userName(userId)}` : 'kill switch');
    this.watch.stopForUser(userId, 'killed');
    const mine = (sessionId: string) => userId === undefined || this.userOfSession(sessionId) === userId;
    for (const p of this.permissions.outstanding()) if (mine(p.sessionId)) this.permissions.respond(p.requestId, 'deny', 'kill-switch');
    this.executor.killAll(userId === undefined ? undefined : this.executorDevices(userId).map((d) => d.deviceId));
    for (const s of this.sessions.values()) if (mine(s.id)) s.stop();
  }

  private onControl(frame: RelayToDevice): void {
    if (frame.t === 'pair.incoming') {
      this.onPairIncoming(frame.pairingId, frame.deviceId, frame.blob);
      return;
    }
    if (frame.t === 'error') log(`relay error ${frame.code}: ${frame.message}`);
  }

  private onPairIncoming(pairingId: string, deviceId: string, blob: string): void {
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.expiresAt < Date.now()) {
      log(`pairing ${pairingId} unknown or expired`);
      return;
    }
    let request;
    try {
      request = openPairRequest({ brain: this.identity, code: pairing.code, blob });
    } catch (e) {
      log(`rejected pairing request: ${String(e)}`);
      return;
    }
    if (request.deviceId !== deviceId) return;
    if (pairing.userId === undefined) {
      // First device through an invite: register the person. Later devices with the same code join them.
      const name = (request.userName?.trim() || pairing.invite?.name?.trim() || request.name).slice(0, 64);
      const user: User = { id: randomUUID().slice(0, 8), name, createdAt: Date.now() };
      this.state.users.push(user);
      pairing.userId = user.id;
      log(`registered "${user.name}" (${user.id})`);
    }
    const userId = pairing.userId;
    for (const old of this.state.devices.filter((d) => d.userId === userId && d.role === request.role && d.name === request.name && d.deviceId !== request.deviceId)) {
      this.removeDevice(old.deviceId);
    }
    const device: PairedDevice = {
      deviceId: request.deviceId,
      role: request.role as PairedDevice['role'],
      name: request.name,
      signPub: request.signPub,
      encPub: request.encPub,
      pairedAt: Date.now(),
      userId,
    };
    this.state.devices = [...this.state.devices.filter((d) => d.deviceId !== device.deviceId), device];
    this.persistNow();
    this.link.addPeer(device.deviceId, device.encPub);
    this.link.sendControl({ t: 'roster.add', entry: { deviceId: device.deviceId, role: device.role, name: device.name, signPub: device.signPub } });
    const reply = sealPairReply({ ok: true, accountId: this.accountId, brainDeviceId: this.deviceId, roster: [] }, device.encPub);
    this.link.sendControl({ t: 'pair.reply', pairingId, deviceId, blob: reply });
    log(`paired ${device.role} "${device.name}" (${device.deviceId}) for ${this.userName(userId)}`);
    if (device.role === 'executor') this.broadcastComputers();
    pairing.onPaired?.(device);
  }

  private async onMessage({ from, message }: IncomingMessage): Promise<void> {
    const device = this.state.devices.find((d) => d.deviceId === from);
    if (!device) return;

    if (device.role === 'executor') {
      switch (message.type) {
        case 'tool.result':
          return this.executor.handleResult(from, message.payload);
        case 'tool.output':
          return this.executor.handleOutput(from, message.payload);
        case 'clipboard.data':
        case 'clipboard.done':
        case 'screen.image':
        case 'computer.done': {
          const req = this.pcRequests.get(message.payload.requestId);
          if (!req || req.deviceId !== from) return;
          clearTimeout(req.timer);
          this.pcRequests.delete(message.payload.requestId);
          req.resolve(message);
          return;
        }
        case 'screen.watch.frame':
          if (this.userOfSession(message.payload.sessionId) === device.userId) this.watch.receiveFrame(from, message.payload);
          return;
        case 'screen.watch.status':
          if (this.userOfSession(message.payload.sessionId) === device.userId) this.watch.receiveStatus(from, message.payload);
          return;
        case 'executor.status':
          this.executor.setInfo(from, message.payload);
          this.watch.selectionChanged(device.userId);
          if (message.payload.watch) {
            if (this.userOfSession(message.payload.watch.sessionId) === device.userId) this.watch.receiveStatus(from, message.payload.watch);
            else this.watch.rejectUnexpectedStatus(from, message.payload.watch);
          }
          this.broadcastComputers();
          return this.broadcastStatus();
        case 'session.list':
          if (this.isOverlay(from)) this.link.send(from, { type: 'session.list.result', payload: { sessions: this.sortedSessions(device.userId) } });
          return;
        case 'session.history': {
          const s = this.isOverlay(from) ? this.sessions.get(message.payload.sessionId) : undefined;
          if (s && this.userOfSession(s.id) === device.userId) this.link.send(from, { type: 'session.history.result', payload: { sessionId: s.id, events: s.history() } });
          return;
        }
        case 'message.send': {
          // The overlay window writes into its person's chats: text only. Tool approvals stay on the phone.
          if (!this.isOverlay(from)) return;
          const s = this.sessions.get(message.payload.sessionId);
          if (!s || this.userOfSession(s.id) !== device.userId) return this.sendError(from, 'unknown_session', 'Session not found');
          return this.sendTurn(s, { text: message.payload.text, from }, from);
        }
<<<<<<< HEAD
        case 'screen.watch.set': {
          if (!this.isOverlay(from)) return;
          const s = this.sessions.get(message.payload.sessionId);
          if (!s || this.userOfSession(s.id) !== device.userId) return this.sendError(from, 'unknown_session', 'Session not found');
          if (message.payload.enabled && this.watchDeviceForSession(s.id)?.deviceId !== from) {
            return this.sendError(from, 'computer_not_selected', 'Select this computer for the chat before enabling screen watching');
          }
          return this.applyWatchRequest(from, device.userId, message.payload);
=======
        case 'models.get':
          if (this.isOverlay(from)) this.link.send(from, { type: 'models.result', payload: { models: await this.listModels() } });
          return;
        case 'session.configure': {
          // The window's model and thinking pickers, for its person's chats.
          if (!this.isOverlay(from)) return;
          const s = this.sessions.get(message.payload.sessionId);
          if (!s || this.userOfSession(s.id) !== device.userId) return this.sendError(from, 'unknown_session', 'Session not found');
          return this.configureSession(s, message.payload);
>>>>>>> origin/main
        }
        default:
          return;
      }
    }

    // Everything below is scoped to the person this client belongs to.
    const userId = device.userId;
    const owner = this.isOwner(userId);
    const mySession = (sessionId: string): Session | undefined => {
      const s = this.sessions.get(sessionId);
      return s && this.userOfSession(s.id) === userId ? s : undefined;
    };
    const myComputer = (deviceId: string) => this.executorDevices(userId).some((d) => d.deviceId === deviceId);

    switch (message.type) {
      case 'status.get':
        return this.sendStatus(from);
      case 'session.list':
        this.link.send(from, { type: 'session.list.result', payload: { sessions: this.sortedSessions(userId) } });
        return;
      case 'session.create': {
        const now = Date.now();
        const meta: SessionMeta = {
          sessionId: randomUUID(),
          title: message.payload.title?.trim() || `Chat ${new Date(now).toLocaleString('ru-RU')}`,
          state: 'idle',
          createdAt: now,
          updatedAt: now,
          userId,
        };
        this.sessions.set(meta.sessionId, new Session(meta, this.sessionHost(), false));
        this.schedulePersist();
        this.toClients(userId, { type: 'session.created', payload: { session: meta } });
        return;
      }
      case 'session.history': {
        const s = mySession(message.payload.sessionId);
        if (!s) return this.sendError(from, 'unknown_session', 'Session not found');
        this.link.send(from, { type: 'session.history.result', payload: { sessionId: s.id, events: s.history() } });
        return;
      }
      case 'message.send': {
        const s = mySession(message.payload.sessionId);
        if (!s) return this.sendError(from, 'unknown_session', 'Session not found');
        return this.sendTurn(s, { text: message.payload.text, attachments: message.payload.attachments, from, ...(message.payload.voice ? { voice: true } : {}) }, from);
      }
      case 'screen.watch.set':
        return this.applyWatchRequest(from, userId, message.payload);
      case 'session.interrupt':
        return mySession(message.payload.sessionId)?.interrupt();
      case 'permission.respond': {
        const sessionId = this.permissionSession(message.payload.requestId);
        if (sessionId && this.userOfSession(sessionId) === userId) this.permissions.respond(message.payload.requestId, message.payload.decision, from);
        return;
      }
      case 'control.kill':
        return this.kill(userId);
      case 'session.configure': {
        const s = mySession(message.payload.sessionId);
        if (!s) return this.sendError(from, 'unknown_session', 'Session not found');
        return this.configureSession(s, message.payload);
      }
      case 'session.hide':
        mySession(message.payload.sessionId)?.setHidden(message.payload.hidden);
        return;
      case 'session.delete': {
        const s = mySession(message.payload.sessionId);
        if (!s) return;
        for (const p of this.permissions.outstanding()) if (p.sessionId === s.id) this.permissions.respond(p.requestId, 'deny', 'deleted');
        this.watch.removeSession(s.id);
        s.destroy();
        this.sessions.delete(s.id);
        this.persistNow();
        this.toClients(userId, { type: 'session.deleted', payload: { sessionId: s.id } });
        return;
      }
      case 'session.rename': {
        const s = mySession(message.payload.sessionId);
        if (!s) return this.sendError(from, 'unknown_session', 'Session not found');
        s.rename(message.payload.title.trim());
        return;
      }
      case 'models.get':
        this.link.send(from, { type: 'models.result', payload: { models: await this.listModels() } });
        return;
      case 'activity.get':
        this.link.send(from, { type: 'activity.result', payload: this.activity(userId) });
        return;
      case 'computers.get':
        this.link.send(from, { type: 'computers.result', payload: this.computers(userId) });
        return;
      case 'computer.select': {
        const { deviceId, sessionId, project } = message.payload;
        if (deviceId === MAC_DEVICE_ID) {
          if (!owner) return this.sendError(from, 'not_owner', "Only the Mac's owner can work on the Mac itself");
          if (sessionId) mySession(sessionId)?.setExecutor(undefined, project);
        } else {
          if (!myComputer(deviceId)) return this.sendError(from, 'unknown_computer', 'That computer is not paired');
          if (sessionId && this.hasTools(deviceId)) mySession(sessionId)?.setExecutor(deviceId, project);
          else this.setActiveExecutor(userId, deviceId);
        }
        this.schedulePersist();
        this.watch.selectionChanged(userId, sessionId);
        this.broadcastComputers();
        this.broadcastStatus();
        return;
      }
      case 'computer.open': {
        const { deviceId, path } = message.payload;
        if (!myComputer(deviceId)) return this.sendError(from, 'unknown_computer', 'That computer is not paired');
        if (!this.link.send(deviceId, { type: 'workspace.open', payload: { path } })) this.sendError(from, 'computer_offline', 'The computer is offline');
        return;
      }
      case 'clipboard.get':
      case 'clipboard.set':
      case 'screen.get': {
        const { requestId, deviceId } = message.payload;
        if (!myComputer(deviceId)) {
          const error = 'That computer is not paired';
          if (message.type === 'clipboard.get') this.link.send(from, { type: 'clipboard.result', payload: { requestId, deviceId, error } });
          else if (message.type === 'clipboard.set') this.link.send(from, { type: 'clipboard.written', payload: { requestId, deviceId, error } });
          else this.link.send(from, { type: 'screen.result', payload: { requestId, deviceId, error } });
          return;
        }
        this.setActiveExecutor(userId, deviceId);
        if (message.type === 'clipboard.get') {
          const r = await this.askPc(deviceId, { type: 'clipboard.read', payload: { requestId } });
          this.link.send(from, { type: 'clipboard.result', payload: { requestId, deviceId, ...(r.items ? { items: r.items } : {}), ...(r.error ? { error: r.error } : {}) } });
        } else if (message.type === 'clipboard.set') {
          const r = await this.askPc(deviceId, { type: 'clipboard.write', payload: { requestId, item: message.payload.item } });
          this.link.send(from, { type: 'clipboard.written', payload: { requestId, deviceId, ...(r.error ? { error: r.error } : {}) } });
        } else {
          const r = await this.askPc(deviceId, { type: 'screen.capture', payload: { requestId } });
          this.link.send(from, { type: 'screen.result', payload: { requestId, deviceId, ...(r.image ? { image: r.image } : {}), ...(r.error ? { error: r.error } : {}) } });
        }
        return;
      }
      case 'computer.pair': {
        try {
          const ticket = this.startPairing(undefined, { userId });
          this.link.send(from, { type: 'computer.pairing', payload: { code: ticket.code, safetyNumber: ticket.safetyNumber, expiresAt: ticket.expiresAt, uri: ticket.uri } });
        } catch (e) {
          this.sendError(from, 'pairing_failed', e instanceof Error ? e.message : String(e));
        }
        return;
      }
      case 'computer.remove': {
        const target = this.executorDevices(userId).find((d) => d.deviceId === message.payload.deviceId);
        if (!target) return;
        this.removeDevice(target.deviceId);
        const panel = this.state.devices.find((d) => d.userId === userId && d.role === 'client' && d.name === `${target.name} (VS Code)`);
        if (panel) this.removeDevice(panel.deviceId);
        return;
      }
      case 'telegram.link': {
        const bot = this.state.telegram?.username;
        if (!bot) return this.sendError(from, 'no_telegram', 'No Telegram bot is set up on the Mac (pocket-claude telegram <token>)');
        try {
          const t = this.startPairing(undefined, { userId });
          this.link.send(from, { type: 'telegram.linking', payload: { url: `https://t.me/${bot}?start=${t.code}`, code: t.code, expiresAt: t.expiresAt } });
        } catch (e) {
          this.sendError(from, 'pairing_failed', e instanceof Error ? e.message : String(e));
        }
        return;
      }
      case 'device.unpair':
        this.removeDevice(from);
        return;
      case 'user.invite': {
        if (!owner) return this.sendError(from, 'not_owner', "Only the Mac's owner can invite people");
        try {
          const t = this.startPairing(undefined, { invite: {} });
          this.link.send(from, { type: 'user.invitation', payload: { uri: t.uri, code: t.code, safetyNumber: t.safetyNumber, expiresAt: t.expiresAt } });
        } catch (e) {
          this.sendError(from, 'pairing_failed', e instanceof Error ? e.message : String(e));
        }
        return;
      }
      default:
        return;
    }
  }

  private async listModels(): Promise<ModelInfo[]> {
    for (const s of this.sessions.values()) {
      if (!s.live) continue;
      try {
        const models = await s.supportedModels();
        if (models?.length) {
          this.models = models;
          break;
        }
      } catch (e) {
        log(`supportedModels failed: ${String(e)}`);
      }
    }
    return this.models ?? FALLBACK_MODELS;
  }

  private activity(userId: string): PayloadOf<'activity.result'> {
    const pending = this.permissions.outstanding();
    const executor = this.defaultExecutor(userId);
    return {
      at: Date.now(),
      sessions: [...this.sessions.values()]
        .filter((s) => this.userOfSession(s.id) === userId && (s.live || s.meta.state !== 'idle' || s.busy))
        .map((s) => ({
          sessionId: s.id,
          title: s.meta.title,
          state: s.meta.state,
          live: s.live,
          ...(this.executorForSession(s.id) ? { executorId: this.executorForSession(s.id) } : {}),
          ...(s.meta.project ? { project: s.meta.project } : {}),
          ...(s.meta.model ? { model: s.meta.model } : {}),
          ...(s.meta.effort ? { effort: s.meta.effort } : {}),
          runningTools: s.runningTools(),
          background: s.backgroundTasks(),
          agents: s.subagents(),
          pendingPermissions: pending.filter((p) => p.sessionId === s.id).length,
          ...(s.turnStarted ? { turnStartedAt: s.turnStarted } : {}),
        })),
      executor: {
        online: this.executor.online(executor),
        workspaces: this.executor.info(executor)?.workspaces ?? [],
        ...(this.executor.info(executor)?.os ? { os: this.executor.info(executor)!.os } : {}),
      },
      ...(this.claudeVersion ? { claudeVersion: this.claudeVersion } : {}),
    };
  }

  /** 'default' is the model list's name for no particular model. */
  private configureSession(s: Session, p: PayloadOf<'session.configure'>): Promise<void> {
    return s.configure({ model: p.model === 'default' ? null : p.model, effort: p.effort });
  }

  /** Starts a turn; if Claude cannot start, the device that wrote hears about it. */
  private async sendTurn(s: Session, turn: UserTurn, from: string): Promise<void> {
    const watchTurn = turn as WatchUserTurn;
    if (!watchTurn.observation) {
      const userId = this.userOfSession(s.id);
      this.watch.noteUserActivity(s.id, userId);
      try {
        const screenFrame = await this.watch.frameForUserTurn(s.id, userId);
        if (screenFrame) turn = { ...watchTurn, screenFrame } as UserTurn;
      } catch (e) {
        log(`watch frame capture failed: ${String(e)}`);
      }
    }
    this.enforceLiveLimit(s.id);
    try {
      await s.send(turn);
    } catch (e) {
      log(`send failed: ${String(e)}`);
      this.sendError(from, 'claude_failed', e instanceof Error ? e.message : String(e));
    }
  }

  private enforceLiveLimit(keepId: string): void {
    const live = [...this.sessions.values()].filter((s) => s.live && s.id !== keepId);
    while (live.length >= MAX_LIVE_SESSIONS) {
      const idle = live.filter((s) => s.meta.state === 'idle' && !s.busy).sort((a, b) => a.meta.updatedAt - b.meta.updatedAt)[0];
      if (!idle) break;
      idle.stop();
      live.splice(live.indexOf(idle), 1);
    }
  }

  private sessionHost() {
    return {
      executorFor: (sessionId: string) =>
        this.executor.handle(
          () => this.executorForSession(sessionId),
          () => {
            const s = this.sessions.get(sessionId);
            return s?.meta.project && s.meta.executorId === this.executorForSession(sessionId) ? s.meta.project : undefined;
          },
        ),
      pcFor: (sessionId: string) => this.pcHandle(sessionId),
      chatOnly: (sessionId: string) => this.chatOnly(sessionId),
      ownerChat: (sessionId: string) => this.isOwner(this.userOfSession(sessionId)),
      userName: (sessionId: string) => this.userName(this.userOfSession(sessionId)),
      emit: (sessionId: string, event: SessionEvent, durable: boolean) => this.emitEvent(sessionId, event, durable),
      metaChanged: (meta: SessionMeta) => {
        this.toClients(meta.userId ?? OWNER_ID, { type: 'session.updated', payload: { session: meta } }, undefined, true);
        this.schedulePersist();
      },
      canUseTool: async (sessionId: string, tool: string, input: Record<string, unknown>, signal: AbortSignal) => {
        const shown = toDisplayCall(tool.replace(/^mcp__pocket__/, ''), input);
        // Computer use is asked about once per chat, so the question is about the chat, not this one click.
        const asked =
          shown.name === COMPUTER_TOOL
            ? { description: computerConsent(this.pcHandle(sessionId).name), action: input.action }
            : shown.name === SANDBOX_NETWORK_TOOL
              ? { host: input.host, description: `Let a command in the Mac sandbox reach ${String(input.host)}` }
              : shown.input;
        const result = await this.permissions.decide(sessionId, shown.name, asked as Record<string, unknown>, signal);
        return result.behavior === 'allow' ? { ...result, updatedInput: input } : result;
      },
      claudeOptions: (): Partial<Options> => ({
        ...(this.state.model ? { model: this.state.model } : {}),
        ...(this.state.effort ? { effort: this.state.effort } : {}),
        ...this.opts.claudeOptions,
      }),
      onClaudeVersion: (v: string) => {
        if (v !== this.claudeVersion) {
          this.claudeVersion = v;
          this.broadcastStatus();
        }
      },
    };
  }

  private async applyWatchRequest(from: string, userId: string, request: PayloadOf<'screen.watch.set'>): Promise<void> {
    const s = this.sessions.get(request.sessionId);
    if (!s || this.userOfSession(s.id) !== userId) return this.sendError(from, 'unknown_session', 'Session not found');
    this.watch.noteUserActivity(s.id, userId);
    const result = await this.watch.set(s.id, userId, request);
    if (result.error) return this.sendError(from, 'screen_watch_failed', result.error);
    if (result.status) this.link.send(from, { type: 'screen.watch.status', payload: result.status });
  }

  private sendWatchObservation(frame: ScreenWatchFrame, context: { goal?: string; retainFrames: number }): Promise<void> | void {
    const s = this.sessions.get(frame.sessionId);
    if (!s) return;
    const turn: WatchUserTurn = {
      from: this.deviceId,
      text: [
        'Это кадр с экрана пользователя.',
        ...(context.goal ? [`Пользователь просил дождаться: ${context.goal}.`] : []),
        'Если здесь видно то, о чём просили рассказать, ошибку, вопрос к пользователю или что-то важное — скажи коротко (1–2 предложения). Иначе ответь ровно [quiet].',
      ].join(' '),
      screenFrame: {
        image: frame.image,
        windowTitle: frame.windowTitle,
        capturedAt: frame.capturedAt,
        frameId: frame.frameId,
        retainFrames: context.retainFrames,
      },
      observation: { windowTitle: frame.windowTitle, capturedAt: frame.capturedAt, ...(context.goal ? { goal: context.goal } : {}) },
    };
    return this.sendTurn(s, turn, this.deviceId);
  }

  private publishWatchStatus(status: ScreenWatchStatus): void {
    const s = this.sessions.get(status.sessionId);
    if (!s) return;
    s.meta = { ...s.meta, watch: status, updatedAt: Date.now() };
    const userId = this.userOfSession(s.id);
    this.toClients(userId, { type: 'session.updated', payload: { session: s.meta } }, undefined, true);
    this.toClients(userId, { type: 'screen.watch.status', payload: status });
    this.schedulePersist();
  }

  private disableRestoredWatcher(deviceId: string): void {
    for (const s of this.sessions.values()) {
      const status = s.meta.watch;
      if (!status || status.deviceId !== deviceId || status.state !== 'off' || status.reason !== 'offline') continue;
      this.link.send(deviceId, {
        type: 'screen.watch.control',
        payload: { sessionId: s.id, watchId: status.watchId, enabled: false, settings: status.settings, ...(status.goal ? { goal: status.goal } : {}) },
      });
    }
  }

  /** Text deltas are coalesced and only sent to clients that are online; everything else is durable and buffered by the relay. */
  private emitEvent(sessionId: string, event: SessionEvent, durable: boolean): void {
    if (event.kind === 'text_delta') {
      const pending = this.pendingDeltas.get(sessionId);
      if (pending) {
        pending.text += event.text;
        return;
      }
      this.pendingDeltas.set(sessionId, {
        text: event.text,
        timer: setTimeout(() => this.flushDeltas(sessionId), DELTA_FLUSH_MS),
      });
      return;
    }
    this.flushDeltas(sessionId);
    if (event.kind === 'result') this.recordUsage(sessionId, event);
    const hint: PushHint | undefined = event.kind === 'result' ? 'completed' : undefined;
    this.toClients(this.userOfSession(sessionId), { type: 'session.event', payload: { sessionId, event } }, hint, !durable);
  }

  private recordUsage(sessionId: string, e: Extract<SessionEvent, { kind: 'result' }>): void {
    const day = new Date().toISOString().slice(0, 10);
    const add = (u: UsageTotals | undefined): UsageTotals => ({
      turns: (u?.turns ?? 0) + 1,
      costUsd: (u?.costUsd ?? 0) + (e.costUsd ?? 0),
      inputTokens: (u?.inputTokens ?? 0) + (e.inputTokens ?? 0),
      outputTokens: (u?.outputTokens ?? 0) + (e.outputTokens ?? 0),
      durationMs: (u?.durationMs ?? 0) + (e.durationMs ?? 0),
    });
    const usage = this.state.usage ?? { days: {}, sessions: {} };
    usage.days[day] = add(usage.days[day]);
    usage.sessions[sessionId] = add(usage.sessions[sessionId]);
    this.state.usage = usage;
    this.schedulePersist();
  }

  private flushDeltas(sessionId: string): void {
    const pending = this.pendingDeltas.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDeltas.delete(sessionId);
    this.toClients(this.userOfSession(sessionId), { type: 'session.event', payload: { sessionId, event: { kind: 'text_delta', text: pending.text } } }, undefined, true);
  }

  /** Sends to one person's clients (and mirrors chat traffic to their overlay computers). */
  private toClients(userId: string, body: InnerMessageBody, pushHint?: PushHint, onlineOnly = false): void {
    for (const d of this.state.devices) {
      if (d.role !== 'client' || d.userId !== userId) continue;
      if (onlineOnly && !this.link.isOnline(d.deviceId)) continue;
      this.link.send(d.deviceId, body, pushHint);
    }
    if (!OVERLAY_MIRRORED.has(body.type)) return;
    // The relay never queues for executors, so only online overlays matter; they fetch history when they come back.
    for (const d of this.executorDevices(userId)) {
      if (this.isOverlay(d.deviceId) && this.link.isOnline(d.deviceId)) this.link.send(d.deviceId, body);
    }
  }

  private hostStatus(userId: string): InnerMessageBody {
    const executor = this.defaultExecutor(userId);
    const user = this.state.users.find((u) => u.id === userId);
    return {
      type: 'host.status',
      payload: {
        ready: !!this.claudeVersion,
        ...(this.claudeVersion ? {} : { reason: 'Claude Code was not found on the Mac' }),
        ...(this.claudeVersion ? { claudeVersion: this.claudeVersion } : {}),
        executorOnline: this.executor.online(executor),
        workspaces: this.executor.info(executor)?.workspaces ?? [],
        ...(user ? { user: { id: user.id, name: user.name, owner: user.owner === true } } : {}),
        ...(this.state.telegram ? { telegramBot: this.state.telegram.username } : {}),
      },
    };
  }

  private sendStatus(to: string): void {
    const userId = this.userOf(to);
    if (!userId) return;
    this.link.send(to, this.hostStatus(userId));
    this.link.send(to, { type: 'computers.result', payload: this.computers(userId) });
    this.link.send(to, { type: 'session.list.result', payload: { sessions: this.sortedSessions(userId) } });
  }

  private broadcastStatus(pushHint?: PushHint): void {
    for (const u of this.state.users) this.toClients(u.id, this.hostStatus(u.id), pushHint, !pushHint);
  }

  private sendError(to: string, code: string, message: string): void {
    this.link.send(to, { type: 'error', payload: { code, message } });
  }

  private sortedSessions(userId: string): SessionMeta[] {
    return [...this.sessions.values()]
      .filter((s) => this.userOfSession(s.id) === userId)
      .map((s) => s.meta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async detectClaudeVersion(): Promise<void> {
    const executable = this.opts.claudeOptions?.pathToClaudeCodeExecutable ?? 'claude';
    try {
      const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 15_000 });
      this.claudeVersion = stdout.trim().split(' ')[0] ?? stdout.trim();
    } catch (e) {
      log(`claude --version failed: ${String(e)}`);
    }
    this.broadcastStatus();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persistNow(), 1_000);
  }

  private persistNow(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.state.sessions = [...this.sessions.values()].map((s) => s.meta);
    this.state.replay = this.link.replayState();
    if (this.opts.persist !== false) saveState(this.state);
  }
}
