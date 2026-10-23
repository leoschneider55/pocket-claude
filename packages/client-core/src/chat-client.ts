import { newMessageId, type ClipboardItem, type Computer, type Project, type Effort, type Identity, type InnerMessageBody, type ModelInfo, type PayloadOf, type PermissionDecision, type ScreenImage, type ScreenWatchSettings, type ScreenWatchStatus, type SessionEvent, type SessionMeta } from '@pocket/protocol';
import { DeviceLink, type IncomingMessage, type WebSocketCtor } from '@pocket/transport';
import { applyEvent, buildThread, type ChatItem } from './thread.js';

const DELTA_INTERVAL_MS = 120;

export type HostStatus = PayloadOf<'host.status'>;
export type PermissionRequest = PayloadOf<'permission.request'>;
export type Activity = PayloadOf<'activity.result'>;
export type PairingTicket = PayloadOf<'computer.pairing'>;
export type Invitation = PayloadOf<'user.invitation'>;
export type TelegramLink = PayloadOf<'telegram.linking'>;

export interface ChatState {
  connection: 'connecting' | 'online' | 'offline';
  brainOnline: boolean;
  host: HostStatus | null;
  sessions: SessionMeta[];
  threads: Record<string, ChatItem[]>;
  /** Sessions whose full history has been loaded from the brain. */
  loaded: Record<string, boolean>;
  permissions: PermissionRequest[];
  models: ModelInfo[];
  activity: Activity | null;
  computers: Computer[];
  /** Default computer for the clipboard. */
  activeComputer: string | null;
  /** The Mac itself as a place to work, with its projects. */
  mac: { name: string; projects: Project[] } | null;
  /** Code to type into VS Code on a new computer, while a pairing is open. */
  pairing: PairingTicket | null;
  /** Link that registers a new person, after `invite()`; owners only. */
  invitation: Invitation | null;
  /** Link that connects the Mac's Telegram bot to this person, after `linkTelegram()`. */
  telegramLink: TelegramLink | null;
  lastError: string | null;
}

export interface ClientCredentials {
  relayUrl: string;
  accountId: string;
  deviceId: string;
  identity: Identity;
  brainDeviceId: string;
  brainEncPub: string;
}

export interface ChatClientOptions extends ClientCredentials {
  WebSocket?: WebSocketCtor;
  replayState?: Record<string, number>;
  log?: (m: string) => void;
  /** The brain announced a new relay address; persist it so the next start uses it. */
  onRelayMoved?: (url: string) => void;
  /** False for clients on the relay's own machine: they keep the local address the brain advertises around. */
  followRelayMoves?: boolean;
  /** How long streamed text is batched before listeners see it (default 120 ms). */
  deltaIntervalMs?: number;
}

/** Only http(s) relay addresses are followed. */
export function isRelayUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

const INITIAL: ChatState = {
  connection: 'connecting',
  brainOnline: false,
  host: null,
  sessions: [],
  threads: {},
  loaded: {},
  permissions: [],
  models: [],
  activity: null,
  computers: [],
  activeComputer: null,
  mac: null,
  pairing: null,
  invitation: null,
  telegramLink: null,
  lastError: null,
};

/**
 * Client-side model of the account: sessions, chat threads and pending permission prompts.
 * Shared by the Android app and the VS Code chat panel. Framework-agnostic: subscribe and render `getState()`.
 */
export class ChatClient {
  private readonly link: DeviceLink;
  private state: ChatState = INITIAL;
  private readonly listeners = new Set<(s: ChatState) => void>();
  /** Streamed text waiting to be applied: deltas are batched so the UI re-renders a few times a second, not on every word. */
  private pendingDelta: { sessionId: string; text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly pendingCreate: ((id: string) => void)[] = [];
  private readonly pendingWatchStatuses = new Map<string, ScreenWatchStatus>();
  private readonly clipboardWaiters = new Map<string, { resolve: (items: ClipboardItem[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly screenWaiters = new Map<string, { resolve: (image: ScreenImage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly opts: ChatClientOptions) {
    this.link = new DeviceLink({
      relayUrl: opts.relayUrl,
      accountId: opts.accountId,
      deviceId: opts.deviceId,
      role: 'client',
      identity: opts.identity,
      peers: { [opts.brainDeviceId]: opts.brainEncPub },
      WebSocket: opts.WebSocket,
      replayState: opts.replayState,
      log: opts.log,
    });
    this.link.on('ready', (_roster, online) => {
      this.patch({ connection: 'online', brainOnline: online.includes(opts.brainDeviceId) });
      this.request({ type: 'status.get', payload: {} });
    });
    this.link.on('disconnected', () => this.patch({ connection: 'offline', brainOnline: false }));
    this.link.on('presence', (deviceId, online) => {
      if (deviceId !== opts.brainDeviceId) return;
      this.patch({ brainOnline: online });
      if (online) this.request({ type: 'status.get', payload: {} });
    });
    this.link.on('control', (f) => {
      if (f.t === 'error') this.patch({ lastError: f.message });
    });
    this.link.on('message', (m) => this.onMessage(m));
  }

  get deviceId(): string {
    return this.opts.deviceId;
  }

  connect(): void {
    this.link.connect();
  }

  close(): void {
    this.flushDelta();
    for (const w of this.clipboardWaiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Disconnected'));
    }
    this.clipboardWaiters.clear();
    this.link.close();
  }

  replayState(): Record<string, number> {
    return this.link.replayState();
  }

  getState(): ChatState {
    return this.state;
  }

  subscribe(listener: (s: ChatState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Seeds the model from a cached snapshot so the UI has something to show before the brain answers. */
  hydrate(snapshot: Pick<ChatState, 'sessions' | 'threads'>): void {
    this.patch({ sessions: snapshot.sessions.map((meta) => this.mergeWatchStatus(meta)), threads: snapshot.threads });
  }

  snapshot(): Pick<ChatState, 'sessions' | 'threads'> {
    return { sessions: this.state.sessions, threads: this.state.threads };
  }

  refresh(): void {
    this.request({ type: 'status.get', payload: {} });
  }

  /** Resolves with the new session id once the brain confirms. */
  createSession(title?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.request({ type: 'session.create', payload: title ? { title } : {} })) {
        reject(new Error('Not connected'));
        return;
      }
      this.pendingCreate.push(resolve);
    });
  }

  loadHistory(sessionId: string): void {
    this.request({ type: 'session.history', payload: { sessionId } });
  }

  send(sessionId: string, text: string, attachments?: { mime: string; dataBase64: string; name?: string }[], opts: { voice?: boolean } = {}): boolean {
    return this.request({ type: 'message.send', payload: { sessionId, text, ...(attachments?.length ? { attachments } : {}), ...(opts.voice ? { voice: true } : {}) } });
  }

  /** Watch control is scoped to the chat; the brain resolves its selected executor and owning person. */
  setScreenWatch(sessionId: string, enabled: boolean, options: { goal?: string; settings?: Partial<ScreenWatchSettings> } = {}): boolean {
    if (!this.state.sessions.some((s) => s.sessionId === sessionId)) {
      this.patch({ lastError: 'Chat not found' });
      return false;
    }
    if (enabled && !this.canWatchScreen(sessionId)) {
      this.patch({ lastError: 'The selected PC is offline or does not support screen watching' });
      return false;
    }
    return this.request({
      type: 'screen.watch.set',
      payload: { sessionId, enabled, ...(options.goal !== undefined ? { goal: options.goal } : {}), ...(options.settings ? { settings: options.settings } : {}) },
    });
  }

  /** True only for this chat's selected PC (or the account default when the chat has no explicit selection). */
  canWatchScreen(sessionId: string): boolean {
    const session = this.state.sessions.find((s) => s.sessionId === sessionId);
    if (!session) return false;
    const deviceId = session.executorId ?? this.state.activeComputer;
    const computer = deviceId ? this.state.computers.find((c) => c.deviceId === deviceId) : undefined;
    return computer?.online === true && computer.capabilities?.includes('watch') === true;
  }

  interrupt(sessionId: string): boolean {
    return this.request({ type: 'session.interrupt', payload: { sessionId } });
  }

  respondPermission(requestId: string, decision: PermissionDecision): boolean {
    const ok = this.request({ type: 'permission.respond', payload: { requestId, decision } });
    if (ok) this.patch({ permissions: this.state.permissions.filter((p) => p.requestId !== requestId) });
    return ok;
  }

  /** `model: 'default'` or `null` resets to the Claude Code default; `effort: null` resets the effort level. */
  configure(sessionId: string, patch: { model?: string | null; effort?: Effort | null }): boolean {
    const ok = this.request({ type: 'session.configure', payload: { sessionId, ...patch } });
    if (ok) {
      this.patch({
        sessions: this.state.sessions.map((s) =>
          s.sessionId !== sessionId
            ? s
            : {
                ...s,
                ...(patch.model !== undefined ? { model: patch.model && patch.model !== 'default' ? patch.model : undefined } : {}),
                ...(patch.effort !== undefined ? { effort: patch.effort ?? undefined } : {}),
              },
        ),
      });
    }
    return ok;
  }

  rename(sessionId: string, title: string): boolean {
    return this.request({ type: 'session.rename', payload: { sessionId, title } });
  }

  loadModels(): boolean {
    return this.request({ type: 'models.get', payload: {} });
  }

  loadActivity(): boolean {
    return this.request({ type: 'activity.get', payload: {} });
  }

  loadComputers(): boolean {
    return this.request({ type: 'computers.get', payload: {} });
  }

  /** Moves a chat to a computer and makes it the default for new chats. */
  selectComputer(deviceId: string, sessionId?: string, project?: string | null): boolean {
    const ok = this.request({
      type: 'computer.select',
      payload: { deviceId, ...(sessionId ? { sessionId } : {}), ...(project !== undefined ? { project } : {}) },
    });
    if (ok) {
      this.patch({
        activeComputer: deviceId,
        sessions: sessionId
          ? this.state.sessions.map((s) =>
              s.sessionId !== sessionId
                ? s
                : { ...s, executorId: deviceId, project: project !== undefined ? (project ?? undefined) : s.executorId === deviceId ? s.project : undefined },
            )
          : this.state.sessions,
      });
    }
    return ok;
  }

  /** Computers whose clipboard the phone can use, the default one first. */
  clipboardComputers(): Computer[] {
    const list = this.state.computers.filter((c) => c.capabilities?.includes('clipboard'));
    return [...list].sort((a, b) => Number(b.deviceId === this.state.activeComputer) - Number(a.deviceId === this.state.activeComputer) || Number(b.online) - Number(a.online));
  }

  /** What is on that computer's clipboard right now. */
  readClipboard(deviceId: string): Promise<ClipboardItem[]> {
    const requestId = newMessageId();
    return this.awaitClipboard(requestId, { type: 'clipboard.get', payload: { requestId, deviceId } });
  }

  async writeClipboard(deviceId: string, item: ClipboardItem): Promise<void> {
    const requestId = newMessageId();
    await this.awaitClipboard(requestId, { type: 'clipboard.set', payload: { requestId, deviceId, item } });
  }

  /** A picture of that computer's screens right now (PocketClipboard with the 'screenshot' capability). */
  screenshot(deviceId: string): Promise<ScreenImage> {
    const requestId = newMessageId();
    return new Promise((resolve, reject) => {
      if (!this.link.send(this.opts.brainDeviceId, { type: 'screen.get', payload: { requestId, deviceId } })) return reject(new Error('Not connected to the Mac'));
      const timer = setTimeout(() => {
        this.screenWaiters.delete(requestId);
        reject(new Error('The computer did not answer'));
      }, 75_000);
      this.screenWaiters.set(requestId, { resolve, reject, timer });
    });
  }

  private awaitClipboard(requestId: string, body: InnerMessageBody): Promise<ClipboardItem[]> {
    return new Promise((resolve, reject) => {
      if (!this.link.send(this.opts.brainDeviceId, body)) return reject(new Error('Not connected to the Mac'));
      const timer = setTimeout(() => {
        this.clipboardWaiters.delete(requestId);
        reject(new Error('The computer did not answer'));
      }, 75_000);
      this.clipboardWaiters.set(requestId, { resolve, reject, timer });
    });
  }

  private settleClipboard(requestId: string, items: ClipboardItem[] | undefined, error: string | undefined): void {
    const w = this.clipboardWaiters.get(requestId);
    if (!w) return;
    clearTimeout(w.timer);
    this.clipboardWaiters.delete(requestId);
    if (error) w.reject(new Error(error));
    else w.resolve(items ?? []);
  }

  /** Opens a project folder in a new VS Code window on that computer. */
  openProject(deviceId: string, path: string): boolean {
    return this.request({ type: 'computer.open', payload: { deviceId, path } });
  }

  hideSession(sessionId: string, hidden: boolean): boolean {
    const ok = this.request({ type: 'session.hide', payload: { sessionId, hidden } });
    if (ok) this.patch({ sessions: this.state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, hidden: hidden || undefined } : s)) });
    return ok;
  }

  deleteSession(sessionId: string): boolean {
    const ok = this.request({ type: 'session.delete', payload: { sessionId } });
    if (ok) this.forgetSession(sessionId);
    return ok;
  }

  private forgetSession(sessionId: string): void {
    this.pendingWatchStatuses.delete(sessionId);
    const { [sessionId]: _thread, ...threads } = this.state.threads;
    const { [sessionId]: _loaded, ...loaded } = this.state.loaded;
    this.patch({
      sessions: this.state.sessions.filter((s) => s.sessionId !== sessionId),
      threads,
      loaded,
      permissions: this.state.permissions.filter((p) => p.sessionId !== sessionId),
    });
  }

  /** Asks the brain for a one-time code; it arrives in `state.pairing`. */
  pairComputer(): boolean {
    this.patch({ pairing: null });
    return this.request({ type: 'computer.pair', payload: {} });
  }

  clearPairing(): void {
    this.patch({ pairing: null });
  }

  /** Owner only: asks for an invite link; it arrives in `state.invitation`. */
  invite(): boolean {
    this.patch({ invitation: null });
    return this.request({ type: 'user.invite', payload: {} });
  }

  clearInvitation(): void {
    this.patch({ invitation: null });
  }

  /** Asks for a Telegram deep link; it arrives in `state.telegramLink`. */
  linkTelegram(): boolean {
    this.patch({ telegramLink: null });
    return this.request({ type: 'telegram.link', payload: {} });
  }

  clearTelegramLink(): void {
    this.patch({ telegramLink: null });
  }

  /** Tells the Mac to forget this device; the caller wipes its keys afterwards. */
  unpairDevice(): boolean {
    return this.link.send(this.opts.brainDeviceId, { type: 'device.unpair', payload: {} });
  }

  /** Who this client belongs to, once the brain has said so. */
  get user(): HostStatus['user'] | undefined {
    return this.state.host?.user;
  }

  removeComputer(deviceId: string): boolean {
    return this.request({ type: 'computer.remove', payload: { deviceId } });
  }

  /** The computer a chat works on: its own choice if still paired, else the default. */
  computerFor(sessionId: string): Computer | undefined {
    const chosen = this.state.sessions.find((s) => s.sessionId === sessionId)?.executorId;
    return this.state.computers.find((c) => c.deviceId === chosen) ?? this.state.computers.find((c) => c.deviceId === this.state.activeComputer);
  }

  kill(): boolean {
    for (const session of this.state.sessions) {
      if (session.watch && session.watch.state !== 'off') this.request({ type: 'screen.watch.set', payload: { sessionId: session.sessionId, enabled: false } });
    }
    return this.request({ type: 'control.kill', payload: { scope: 'all' } });
  }

  clearError(): void {
    this.patch({ lastError: null });
  }

  private request(body: InnerMessageBody): boolean {
    const ok = this.link.send(this.opts.brainDeviceId, body);
    if (!ok) this.patch({ lastError: 'Not connected to the Mac' });
    return ok;
  }

  private onMessage({ from, message }: IncomingMessage): void {
    if (from !== this.opts.brainDeviceId) return;
    switch (message.type) {
      case 'host.status':
        return this.patch({ host: message.payload, brainOnline: true });
      case 'session.list.result':
        return this.patch({ sessions: sortSessions(message.payload.sessions.map((meta) => this.mergeWatchStatus(meta))) });
      case 'session.created': {
        this.upsertSession(message.payload.session);
        this.patch({ loaded: { ...this.state.loaded, [message.payload.session.sessionId]: true } });
        this.pendingCreate.shift()?.(message.payload.session.sessionId);
        return;
      }
      case 'session.updated':
        return this.upsertSession(message.payload.session);
      case 'session.deleted':
        return this.forgetSession(message.payload.sessionId);
      case 'session.history.result':
        return this.patch({
          threads: { ...this.state.threads, [message.payload.sessionId]: buildThread(message.payload.events) },
          loaded: { ...this.state.loaded, [message.payload.sessionId]: true },
        });
      case 'session.event': {
        const { sessionId, event } = message.payload;
        if (event.kind === 'text_delta') {
          if (this.pendingDelta?.sessionId === sessionId) {
            this.pendingDelta.text += event.text;
            return;
          }
          this.flushDelta();
          this.pendingDelta = { sessionId, text: event.text, timer: setTimeout(() => this.flushDelta(), this.opts.deltaIntervalMs ?? DELTA_INTERVAL_MS) };
          return;
        }
        this.flushDelta();
        return this.applySessionEvent(sessionId, event);
      }
      case 'permission.request':
        if (this.state.permissions.some((p) => p.requestId === message.payload.requestId)) return;
        return this.patch({ permissions: [...this.state.permissions, message.payload] });
      case 'permission.resolved':
        return this.patch({ permissions: this.state.permissions.filter((p) => p.requestId !== message.payload.requestId) });
      case 'error':
        return this.patch({ lastError: message.payload.message });
      case 'models.result':
        return this.patch({ models: message.payload.models });
      case 'activity.result':
        return this.patch({ activity: message.payload });
      case 'computers.result': {
        const known = new Set(this.state.computers.map((c) => c.deviceId));
        const added = this.state.pairing && message.payload.computers.some((c) => !known.has(c.deviceId));
        return this.patch({
          computers: message.payload.computers,
          activeComputer: message.payload.activeId,
          mac: message.payload.mac ?? this.state.mac,
          ...(added ? { pairing: null } : {}),
        });
      }
      case 'computer.pairing':
        return this.patch({ pairing: message.payload });
      case 'user.invitation':
        return this.patch({ invitation: message.payload });
      case 'telegram.linking':
        return this.patch({ telegramLink: message.payload });
      case 'clipboard.result':
        return this.settleClipboard(message.payload.requestId, message.payload.items, message.payload.error);
      case 'clipboard.written':
        return this.settleClipboard(message.payload.requestId, [], message.payload.error);
      case 'screen.result': {
        const w = this.screenWaiters.get(message.payload.requestId);
        if (!w) return;
        clearTimeout(w.timer);
        this.screenWaiters.delete(message.payload.requestId);
        if (message.payload.image) w.resolve(message.payload.image);
        else w.reject(new Error(message.payload.error ?? 'No image'));
        return;
      }
      case 'screen.watch.status': {
        const session = this.state.sessions.find((s) => s.sessionId === message.payload.sessionId);
        if (!session) {
          this.pendingWatchStatuses.set(message.payload.sessionId, message.payload);
          return;
        }
        return this.upsertSession({ ...session, watch: message.payload });
      }
      case 'relay.moved':
        if (this.opts.followRelayMoves === false || !isRelayUrl(message.payload.url) || message.payload.url === this.link.currentRelayUrl) return;
        this.link.setRelayUrl(message.payload.url);
        this.opts.onRelayMoved?.(message.payload.url);
        return;
      default:
        return;
    }
  }

  private upsertSession(meta: SessionMeta): void {
    meta = this.mergeWatchStatus(meta);
    const others = this.state.sessions.filter((s) => s.sessionId !== meta.sessionId);
    this.patch({ sessions: sortSessions([...others, meta]) });
  }

  private mergeWatchStatus(meta: SessionMeta): SessionMeta {
    const pending = this.pendingWatchStatuses.get(meta.sessionId);
    if (pending) {
      this.pendingWatchStatuses.delete(meta.sessionId);
      return { ...meta, watch: pending };
    }
    const current = this.state.sessions.find((s) => s.sessionId === meta.sessionId)?.watch;
    return meta.watch === undefined && current ? { ...meta, watch: current } : meta;
  }

  private applySessionEvent(sessionId: string, event: SessionEvent): void {
    const thread = this.state.threads[sessionId] ?? [];
    const patch: Partial<ChatState> = { threads: { ...this.state.threads, [sessionId]: applyEvent(thread, event) } };
    if (event.kind === 'state') {
      patch.sessions = this.state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, state: event.state } : s));
    }
    this.patch(patch);
  }

  private flushDelta(): void {
    const pending = this.pendingDelta;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDelta = null;
    this.applySessionEvent(pending.sessionId, { kind: 'text_delta', text: pending.text });
  }

  private patch(p: Partial<ChatState>): void {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l(this.state);
  }
}

function sortSessions(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}
