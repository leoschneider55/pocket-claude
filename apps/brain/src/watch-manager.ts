import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SCREEN_WATCH_SETTINGS,
  screenWatchSettingsSchema,
  type PayloadOf,
  type ScreenWatchFrame,
  type ScreenWatchReason,
  type ScreenWatchSettings,
  type ScreenWatchStatus,
} from '@pocket/protocol';

export const WATCH_IDLE_TIMEOUT_MS = 15 * 60_000;
export const WATCH_FRAME_FRESH_MS = 10_000;
export const WATCH_CAPTURE_TIMEOUT_MS = 8_000;
const FUTURE_FRAME_SKEW_MS = 5_000;
const RECENT_FRAME_IDS = 256;

export interface WatchScreenFrame {
  image: ScreenWatchFrame['image'];
  windowTitle: string;
  capturedAt: number;
  frameId: string;
  retainFrames: number;
}

export interface WatchSession {
  userId: string;
  state: 'idle' | 'running' | 'waiting_permission' | 'ended';
  busy: boolean;
  watch?: ScreenWatchStatus;
}

export interface WatchDevice {
  deviceId: string;
  userId: string;
  online: boolean;
  capabilities: readonly string[];
}

export interface WatchCommandResult {
  status?: ScreenWatchStatus;
  error?: string;
}

export interface WatchManagerHost {
  session(sessionId: string): WatchSession | undefined;
  deviceForSession(sessionId: string): WatchDevice | undefined;
  canObserve(sessionId: string): boolean;
  sendControl(deviceId: string, payload: PayloadOf<'screen.watch.control'>): boolean;
  sendCapture(deviceId: string, payload: PayloadOf<'screen.watch.capture'>): boolean;
  publish(status: ScreenWatchStatus): void;
  notice(sessionId: string, text: string): void;
  observe(frame: ScreenWatchFrame, context: { goal?: string; retainFrames: number }): Promise<void> | void;
}

export interface WatchManagerOptions {
  now?: () => number;
  idleTimeoutMs?: number;
  captureTimeoutMs?: number;
  newId?: () => string;
}

export function isFreshWatchFrame(capturedAt: number, now: number, maxAgeMs = WATCH_FRAME_FRESH_MS): boolean {
  return capturedAt <= now + FUTURE_FRAME_SKEW_MS && capturedAt >= now - maxAgeMs;
}

export function isWatchIdleExpired(lastActivityAt: number, now: number, idleTimeoutMs = WATCH_IDLE_TIMEOUT_MS): boolean {
  return now - lastActivityAt >= idleTimeoutMs;
}

export class ObservationRateLimiter {
  private readonly observedAt: number[] = [];

  canRecord(now: number, maxPerMinute: number, maxPerHour: number): boolean {
    this.prune(now);
    const minuteCount = this.observedAt.filter((at) => at > now - 60_000).length;
    return minuteCount < maxPerMinute && this.observedAt.length < maxPerHour;
  }

  record(now: number, maxPerMinute: number, maxPerHour: number): boolean {
    if (!this.canRecord(now, maxPerMinute, maxPerHour)) return false;
    this.observedAt.push(now);
    return true;
  }

  private prune(now: number): void {
    while (this.observedAt[0] !== undefined && this.observedAt[0] <= now - 60 * 60_000) this.observedAt.shift();
  }
}

interface ActiveWatch {
  sessionId: string;
  userId: string;
  watchId: string;
  deviceId: string;
  settings: ScreenWatchSettings;
  goal?: string;
  state: 'watching' | 'paused';
  lastUserActivityAt: number;
  lastCapturedAt: number;
  seenFrameIds: Set<string>;
  observationPending: boolean;
}

interface PendingCapture {
  sessionId: string;
  watchId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (frame: ScreenWatchFrame | undefined) => void;
}

/** Coordinates one user's active watcher, retaining only the newest frame for its chat. */
export class WatchManager {
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly captureTimeoutMs: number;
  private readonly newId: () => string;
  private readonly statuses = new Map<string, ScreenWatchStatus>();
  private readonly frames = new Map<string, ScreenWatchFrame>();
  private readonly limiters = new Map<string, ObservationRateLimiter>();
  private readonly captures = new Map<string, PendingCapture>();
  private readonly captureInFlight = new Map<string, Promise<ScreenWatchFrame | undefined>>();
  private active: ActiveWatch | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: WatchManagerHost, options: WatchManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleTimeoutMs = options.idleTimeoutMs ?? WATCH_IDLE_TIMEOUT_MS;
    this.captureTimeoutMs = options.captureTimeoutMs ?? WATCH_CAPTURE_TIMEOUT_MS;
    this.newId = options.newId ?? randomUUID;
  }

  current(): ScreenWatchStatus | undefined {
    return this.active ? this.makeStatus(this.active, this.active.state) : undefined;
  }

  statusForSession(sessionId: string): ScreenWatchStatus | undefined {
    return this.statuses.get(sessionId) ?? this.host.session(sessionId)?.watch;
  }

  async set(
    sessionId: string,
    userId: string,
    request: { enabled: boolean; goal?: string; settings?: Partial<ScreenWatchSettings> },
  ): Promise<WatchCommandResult> {
    const session = this.host.session(sessionId);
    if (!session || session.userId !== userId) return { error: 'Session not found' };
    if (!request.enabled) return this.disable(sessionId, userId);

    const device = this.host.deviceForSession(sessionId);
    if (!device || device.userId !== userId) return { error: 'No computer is selected for this chat' };
    if (!device.online) return { error: 'The selected computer is offline' };
    if (!device.capabilities.includes('watch')) return { error: 'The selected computer does not support screen watching' };

    let settings: ScreenWatchSettings;
    try {
      settings = screenWatchSettingsSchema.parse({
        ...DEFAULT_SCREEN_WATCH_SETTINGS,
        ...(this.statusForSession(sessionId)?.settings ?? {}),
        ...request.settings,
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const goal = request.goal?.trim() ? request.goal.trim() : undefined;
    const current = this.active;
    if (current && current.userId !== userId) return { error: 'The active watcher belongs to another person' };
    if (current && current.sessionId === sessionId && current.deviceId === device.deviceId && current.state === 'watching') {
      if (this.sameSettings(current.settings, settings) && current.goal === goal) return { status: this.makeStatus(current, 'watching') };
      this.sendControl(current, false);
      this.cancelCaptures(current.sessionId);
      this.frames.delete(current.sessionId);
      this.active = null;
    } else if (current) {
      this.stopActive('replaced', { notice: 'Наблюдение остановлено: включено в другом чате.' });
    }

    const now = this.now();
    const active: ActiveWatch = {
      sessionId,
      userId,
      watchId: this.newId(),
      deviceId: device.deviceId,
      settings,
      ...(goal ? { goal } : {}),
      state: 'watching',
      lastUserActivityAt: now,
      lastCapturedAt: -1,
      seenFrameIds: new Set(),
      observationPending: false,
    };
    this.active = active;
    this.scheduleIdleStop();
    const status = this.publish(active, 'watching');
    if (!this.sendControl(active, true)) {
      this.stopActive('offline', { notice: 'Наблюдение остановлено: компьютер офлайн.' });
      return { error: 'The selected computer is offline' };
    }
    return { status };
  }

  noteUserActivity(sessionId: string, userId: string): void {
    const active = this.active;
    if (!active || active.sessionId !== sessionId || active.userId !== userId) return;
    active.lastUserActivityAt = this.now();
    this.scheduleIdleStop();
  }

  async frameForUserTurn(sessionId: string, userId: string): Promise<WatchScreenFrame | undefined> {
    const active = this.active;
    if (!active || active.sessionId !== sessionId || active.userId !== userId) return undefined;
    const cached = this.frames.get(sessionId);
    if (cached && isFreshWatchFrame(cached.capturedAt, this.now())) return this.toAttachment(cached, active.settings);
    if (active.state !== 'watching') return undefined;
    const frame = await this.captureFresh(active);
    return frame ? this.toAttachment(frame, active.settings) : undefined;
  }

  receiveFrame(from: string, frame: ScreenWatchFrame): boolean {
    const active = this.active;
    if (!active || active.state !== 'watching') return false;
    if (from !== active.deviceId || frame.sessionId !== active.sessionId || frame.watchId !== active.watchId) return false;
    const now = this.now();
    if (!isFreshWatchFrame(frame.capturedAt, now) || frame.capturedAt <= active.lastCapturedAt || active.seenFrameIds.has(frame.frameId)) return false;

    const pending = frame.requestId ? this.captures.get(frame.requestId) : undefined;
    if (frame.requestId && (!pending || pending.sessionId !== frame.sessionId || pending.watchId !== frame.watchId)) return false;

    active.lastCapturedAt = frame.capturedAt;
    active.seenFrameIds.add(frame.frameId);
    if (active.seenFrameIds.size > RECENT_FRAME_IDS) active.seenFrameIds.delete(active.seenFrameIds.values().next().value!);
    this.frames.set(frame.sessionId, frame);

    if (pending) {
      clearTimeout(pending.timer);
      this.captures.delete(frame.requestId!);
      pending.resolve(frame);
      return true;
    }
    if (active.observationPending || !this.host.canObserve(active.sessionId)) return true;

    const limiter = this.limiterFor(active.sessionId);
    if (!limiter.record(now, active.settings.maxPerMinute, active.settings.maxPerHour)) {
      this.pauseActive('limit', 'Пауза наблюдения: много изменений.');
      return true;
    }
    active.observationPending = true;
    let observation: Promise<void> | void;
    try {
      observation = this.host.observe(frame, { ...(active.goal ? { goal: active.goal } : {}), retainFrames: active.settings.retainFrames });
    } catch {
      active.observationPending = false;
      return true;
    }
    if (observation && typeof observation.then === 'function') {
      void observation.catch(() => undefined).finally(() => {
        if (this.active?.watchId === active.watchId) active.observationPending = false;
      });
    } else active.observationPending = false;
    return true;
  }

  receiveStatus(from: string, status: ScreenWatchStatus): boolean {
    if (status.deviceId !== from) return false;
    const active = this.active;
    if (!active || active.deviceId !== from || active.sessionId !== status.sessionId || active.watchId !== status.watchId) {
      if (status.state !== 'off') this.sendStaleStop(from, status);
      return false;
    }
    if (active.state === 'paused' && status.state === 'watching') {
      this.sendControl(active, false);
      return false;
    }
    if (status.state === 'watching') {
      this.publish(active, 'watching');
      return true;
    }
    const reason = status.reason ?? 'user';
    if (reason === 'limit') {
      this.pauseActive('limit', 'Пауза наблюдения: много изменений.');
      return true;
    }
    this.stopActive(reason, { notice: this.stopNotice(reason) });
    return true;
  }

  deviceOffline(deviceId: string): void {
    if (this.active?.deviceId === deviceId) this.stopActive('offline', { notice: 'Наблюдение остановлено: компьютер офлайн.' });
  }

  deviceRemoved(deviceId: string): void {
    if (this.active?.deviceId === deviceId) this.stopActive('offline', { notice: 'Наблюдение остановлено: компьютер отключён.' });
  }

  selectionChanged(userId: string, sessionId?: string): void {
    const active = this.active;
    if (!active || active.userId !== userId || (sessionId && active.sessionId !== sessionId)) return;
    const device = this.host.deviceForSession(active.sessionId);
    if (!device || device.deviceId !== active.deviceId || !device.online || !device.capabilities.includes('watch')) {
      this.stopActive('replaced', { notice: 'Наблюдение остановлено: изменён выбранный компьютер.' });
    }
  }

  stopForUser(userId: string | undefined, reason: ScreenWatchReason, notify = true): void {
    if (!this.active || (userId !== undefined && this.active.userId !== userId)) return;
    this.stopActive(reason, { notice: notify ? this.stopNotice(reason) : undefined });
  }

  removeSession(sessionId: string): void {
    if (this.active?.sessionId === sessionId) this.stopActive('user');
    this.frames.delete(sessionId);
    this.statuses.delete(sessionId);
    this.limiters.delete(sessionId);
    this.cancelCaptures(sessionId);
  }

  /** Disables any watcher the PC reports after reconnect; reconnect never resumes a prior watch. */
  rejectUnexpectedStatus(from: string, status: ScreenWatchStatus): void {
    const active = this.active;
    if (active && active.deviceId === from && active.watchId === status.watchId && active.sessionId === status.sessionId) return;
    if (status.state !== 'off') this.sendStaleStop(from, status);
  }

  shutdown(): void {
    if (this.active) this.stopActive('offline');
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const requestId of [...this.captures.keys()]) this.finishCapture(requestId, undefined);
  }

  private disable(sessionId: string, userId: string): WatchCommandResult {
    const active = this.active;
    if (active && active.userId !== userId) return { error: 'The active watcher belongs to another person' };
    if (active) return { status: this.stopActive('user') };
    const previous = this.statusForSession(sessionId);
    if (!previous) return {};
    if (previous.state !== 'off') {
      const status: ScreenWatchStatus = { ...previous, state: 'off', reason: 'user' };
      this.publishStatus(status);
      return { status };
    }
    return { status: previous };
  }

  private stopActive(reason: ScreenWatchReason, opts: { notice?: string; state?: 'off' | 'paused' } = {}): ScreenWatchStatus | undefined {
    const active = this.active;
    if (!active) return undefined;
    const state = opts.state ?? 'off';
    active.state = state === 'paused' ? 'paused' : active.state;
    this.sendControl(active, false);
    this.cancelCaptures(active.sessionId);
    if (state === 'off') {
      this.active = null;
      this.frames.delete(active.sessionId);
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const status = this.publish(active, state, reason);
    if (opts.notice) this.host.notice(active.sessionId, opts.notice);
    return status;
  }

  private pauseActive(reason: ScreenWatchReason, notice: string): void {
    if (!this.active || this.active.state === 'paused') return;
    this.stopActive(reason, { state: 'paused', notice });
  }

  private publish(active: ActiveWatch, state: ScreenWatchStatus['state'], reason?: ScreenWatchReason): ScreenWatchStatus {
    const status = this.makeStatus(active, state, reason);
    this.publishStatus(status);
    return status;
  }

  private publishStatus(status: ScreenWatchStatus): void {
    this.statuses.set(status.sessionId, status);
    this.host.publish(status);
  }

  private makeStatus(active: ActiveWatch, state: ScreenWatchStatus['state'], reason?: ScreenWatchReason): ScreenWatchStatus {
    return {
      sessionId: active.sessionId,
      watchId: active.watchId,
      deviceId: active.deviceId,
      state,
      ...(reason ? { reason } : {}),
      ...(active.goal ? { goal: active.goal } : {}),
      settings: active.settings,
    };
  }

  private sendControl(active: ActiveWatch, enabled: boolean): boolean {
    return this.host.sendControl(active.deviceId, {
      sessionId: active.sessionId,
      watchId: active.watchId,
      enabled,
      settings: active.settings,
      ...(active.goal ? { goal: active.goal } : {}),
    });
  }

  private sendStaleStop(deviceId: string, status: ScreenWatchStatus): void {
    this.host.sendControl(deviceId, {
      sessionId: status.sessionId,
      watchId: status.watchId,
      enabled: false,
      settings: status.settings,
      ...(status.goal ? { goal: status.goal } : {}),
    });
  }

  private stopNotice(reason: ScreenWatchReason): string | undefined {
    switch (reason) {
      case 'idle': return 'Наблюдение остановлено: 15 минут без активности.';
      case 'locked': return 'Наблюдение остановлено: экран заблокирован.';
      case 'sleep': return 'Наблюдение остановлено: компьютер уснул.';
      case 'offline': return 'Наблюдение остановлено: компьютер офлайн.';
      case 'error': return 'Наблюдение остановлено: ошибка агента.';
      case 'killed': return 'Наблюдение остановлено kill switch.';
      case 'replaced': return 'Наблюдение остановлено: включено в другом чате.';
      default: return undefined;
    }
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const active = this.active;
    if (!active) return;
    const remaining = Math.max(0, active.lastUserActivityAt + this.idleTimeoutMs - this.now());
    this.idleTimer = setTimeout(() => {
      const current = this.active;
      if (!current || current.watchId !== active.watchId) return;
      if (isWatchIdleExpired(current.lastUserActivityAt, this.now(), this.idleTimeoutMs)) {
        this.stopActive('idle', { notice: this.stopNotice('idle') });
      } else this.scheduleIdleStop();
    }, remaining);
  }

  private limiterFor(sessionId: string): ObservationRateLimiter {
    let limiter = this.limiters.get(sessionId);
    if (!limiter) {
      limiter = new ObservationRateLimiter();
      this.limiters.set(sessionId, limiter);
    }
    return limiter;
  }

  private sameSettings(a: ScreenWatchSettings, b: ScreenWatchSettings): boolean {
    return Object.keys(DEFAULT_SCREEN_WATCH_SETTINGS).every((key) => a[key as keyof ScreenWatchSettings] === b[key as keyof ScreenWatchSettings]);
  }

  private async captureFresh(active: ActiveWatch): Promise<ScreenWatchFrame | undefined> {
    const existing = this.captureInFlight.get(active.sessionId);
    if (existing) return existing;
    const promise = new Promise<ScreenWatchFrame | undefined>((resolve) => {
      const requestId = this.newId();
      const timer = setTimeout(() => this.finishCapture(requestId, undefined), this.captureTimeoutMs);
      this.captures.set(requestId, { sessionId: active.sessionId, watchId: active.watchId, timer, resolve });
      const sent = this.host.sendCapture(active.deviceId, { sessionId: active.sessionId, watchId: active.watchId, requestId });
      if (!sent) this.finishCapture(requestId, undefined);
    });
    this.captureInFlight.set(active.sessionId, promise);
    try {
      return await promise;
    } finally {
      if (this.captureInFlight.get(active.sessionId) === promise) this.captureInFlight.delete(active.sessionId);
    }
  }

  private finishCapture(requestId: string, frame: ScreenWatchFrame | undefined): void {
    const pending = this.captures.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.captures.delete(requestId);
    pending.resolve(frame);
  }

  private cancelCaptures(sessionId: string): void {
    for (const [requestId, pending] of this.captures) {
      if (pending.sessionId === sessionId) this.finishCapture(requestId, undefined);
    }
  }

  private toAttachment(frame: ScreenWatchFrame, settings: ScreenWatchSettings): WatchScreenFrame {
    return {
      image: frame.image,
      windowTitle: frame.windowTitle,
      capturedAt: frame.capturedAt,
      frameId: frame.frameId,
      retainFrames: settings.retainFrames,
    };
  }
}
