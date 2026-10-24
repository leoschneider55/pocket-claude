import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PayloadOf, ScreenWatchFrame, ScreenWatchSettings, ScreenWatchStatus } from '@pocket/protocol';
import {
  ObservationRateLimiter,
  WATCH_IDLE_TIMEOUT_MS,
  WatchManager,
  isFreshWatchFrame,
  isWatchIdleExpired,
  type WatchDevice,
  type WatchManagerHost,
  type WatchSession,
} from '../src/watch-manager.js';

const settings: ScreenWatchSettings = {
  intervalMs: 1000,
  changeThreshold: 0.08,
  settleMs: 1500,
  display: 0,
  maxPerMinute: 4,
  maxPerHour: 60,
  retainFrames: 2,
};

function frame(watchId: string, overrides: Partial<ScreenWatchFrame> = {}): ScreenWatchFrame {
  return {
    sessionId: 's1',
    watchId,
    frameId: 'f1',
    capturedAt: Date.now(),
    image: { mime: 'image/jpeg', dataBase64: 'AAAA', width: 16, height: 9 },
    windowTitle: 'Terminal',
    processName: 'powershell',
    display: 0,
    ...overrides,
  };
}

function fixture(options: ConstructorParameters<typeof WatchManager>[1] = {}) {
  const sessions = new Map<string, WatchSession>([
    ['s1', { userId: 'u1', state: 'idle', busy: false }],
    ['s2', { userId: 'u1', state: 'idle', busy: false }],
  ]);
  const devices = new Map<string, WatchDevice>([
    ['s1', { deviceId: 'pc1', userId: 'u1', online: true, capabilities: ['watch'] }],
    ['s2', { deviceId: 'pc1', userId: 'u1', online: true, capabilities: ['watch'] }],
  ]);
  const controls: { deviceId: string; payload: PayloadOf<'screen.watch.control'> }[] = [];
  const captures: { deviceId: string; payload: PayloadOf<'screen.watch.capture'> }[] = [];
  const statuses: ScreenWatchStatus[] = [];
  const notices: { sessionId: string; text: string }[] = [];
  const observations: { frame: ScreenWatchFrame; context: { goal?: string; retainFrames: number } }[] = [];
  const host: WatchManagerHost = {
    session: (id) => sessions.get(id),
    deviceForSession: (id) => devices.get(id),
    canObserve: (id) => {
      const session = sessions.get(id);
      return session?.state === 'idle' && !session.busy;
    },
    sendControl: (deviceId, payload) => (controls.push({ deviceId, payload }), true),
    sendCapture: (deviceId, payload) => (captures.push({ deviceId, payload }), true),
    publish: (status) => void statuses.push(status),
    notice: (sessionId, text) => void notices.push({ sessionId, text }),
    observe: (screen, context) => void observations.push({ frame: screen, context }),
  };
  let now = Date.now();
  const manager = new WatchManager(host, { now: () => now, newId: (() => { let n = 0; return () => `watch-${++n}`; })(), ...options });
  return { manager, sessions, devices, controls, captures, statuses, notices, observations, setNow: (at: number) => { now = at; }, now: () => now };
}

afterEach(() => vi.useRealTimers());

describe('watch policy', () => {
  it('enforces sliding minute and hour observation limits', () => {
    const rate = new ObservationRateLimiter();
    expect(rate.record(1_000, 2, 3)).toBe(true);
    expect(rate.record(2_000, 2, 3)).toBe(true);
    expect(rate.record(3_000, 2, 3)).toBe(false);
    expect(rate.record(61_000, 2, 3)).toBe(true);
    expect(rate.record(3_601_001, 2, 3)).toBe(true);
  });

  it('checks frame freshness and the 15-minute inactivity boundary', () => {
    expect(isFreshWatchFrame(90_000, 100_000)).toBe(true);
    expect(isFreshWatchFrame(89_999, 100_000)).toBe(false);
    expect(isFreshWatchFrame(105_001, 100_000)).toBe(false);
    expect(isWatchIdleExpired(10_000, 10_000 + WATCH_IDLE_TIMEOUT_MS - 1)).toBe(false);
    expect(isWatchIdleExpired(10_000, 10_000 + WATCH_IDLE_TIMEOUT_MS)).toBe(true);
  });
});

describe('WatchManager', () => {
  it('starts only on an online selected computer with watch capability', async () => {
    const f = fixture();
    f.devices.set('s1', { deviceId: 'pc2', userId: 'u2', online: true, capabilities: ['watch'] });
    expect((await f.manager.set('s1', 'u1', { enabled: true })).error).toMatch(/selected/);
    f.devices.set('s1', { deviceId: 'pc1', userId: 'u1', online: true, capabilities: ['screenshot'] });
    expect((await f.manager.set('s1', 'u1', { enabled: true })).error).toMatch(/support/);
    f.devices.set('s1', { deviceId: 'pc1', userId: 'u1', online: false, capabilities: ['watch'] });
    expect((await f.manager.set('s1', 'u1', { enabled: true })).error).toMatch(/offline/);
    expect(f.controls).toHaveLength(0);
  });

  it('replaces the one active watch across chats and scopes notices to its session', async () => {
    const f = fixture();
    await f.manager.set('s1', 'u1', { enabled: true });
    const oldWatchId = f.manager.current()!.watchId;
    const second = await f.manager.set('s2', 'u1', { enabled: true });
    expect(second.status).toMatchObject({ sessionId: 's2', state: 'watching' });
    expect(f.controls.filter((c) => c.payload.watchId === oldWatchId).map((c) => c.payload.enabled)).toEqual([true, false]);
    expect(f.notices).toEqual([{ sessionId: 's1', text: 'Наблюдение остановлено: включено в другом чате.' }]);
  });

  it('rejects foreign-user controls, wrong senders, stale watch ids, old and replayed frames', async () => {
    const f = fixture();
    await f.manager.set('s1', 'u1', { enabled: true });
    const watchId = f.manager.current()!.watchId;
    const accepted = frame(watchId);
    expect((await f.manager.set('s1', 'u2', { enabled: false })).error).toMatch(/not found/);
    expect(f.manager.receiveFrame('another-pc', accepted)).toBe(false);
    expect(f.manager.receiveFrame('pc1', frame('old-watch', { frameId: 'old' }))).toBe(false);
    expect(f.manager.receiveFrame('pc1', frame(watchId, { frameId: 'stale', capturedAt: Date.now() - 20_000 }))).toBe(false);
    expect(f.manager.receiveFrame('pc1', accepted)).toBe(true);
    expect(f.manager.receiveFrame('pc1', accepted)).toBe(false);
    expect(f.observations).toHaveLength(1);
  });

  it('keeps different owners and devices isolated when stopping or hitting limits', async () => {
    const f = fixture();
    f.sessions.set('s3', { userId: 'u2', state: 'idle', busy: false });
    f.devices.set('s3', { deviceId: 'pc2', userId: 'u2', online: true, capabilities: ['watch'] });
    const first = (await f.manager.set('s1', 'u1', { enabled: true, settings: { maxPerMinute: 1 } })).status!;
    const second = (await f.manager.set('s3', 'u2', { enabled: true })).status!;
    expect(f.controls.map((control) => control.payload.enabled)).toEqual([true, true]);

    await f.manager.set('s2', 'u1', { enabled: false });
    expect(f.manager.currentForSession('s1')?.state).toBe('watching');
    f.manager.receiveFrame('pc1', frame(first.watchId));
    f.manager.receiveFrame('pc1', frame(first.watchId, { frameId: 'f2', capturedAt: Date.now() + 1 }));
    expect(f.manager.currentForSession('s1')?.state).toBe('paused');
    expect(f.manager.currentForSession('s3')?.state).toBe('watching');
    f.manager.receiveStatus('pc1', { ...first, state: 'off', reason: 'user' });
    expect(f.manager.currentForSession('s1')).toMatchObject({ state: 'paused', reason: 'limit' });

    f.manager.stopForUser('u1', 'killed');
    expect(f.manager.currentForSession('s1')).toBeUndefined();
    expect(f.manager.receiveFrame('pc2', frame(second.watchId, { sessionId: 's3' }))).toBe(true);
    expect(f.manager.currentForSession('s3')?.state).toBe('watching');
    f.manager.shutdown();
  });

  it('does not return a capture after its watcher is stopped', async () => {
    const f = fixture();
    const active = (await f.manager.set('s1', 'u1', { enabled: true })).status!;
    const pending = f.manager.frameForUserTurn('s1', 'u1');
    const requestId = f.captures[0]!.payload.requestId;
    f.manager.receiveFrame('pc1', frame(active.watchId, { requestId }));
    await f.manager.set('s1', 'u1', { enabled: false });
    expect(await pending).toBeUndefined();
  });

  it('keeps only the latest busy frame for the next user turn', async () => {
    const f = fixture();
    await f.manager.set('s1', 'u1', { enabled: true });
    const watchId = f.manager.current()!.watchId;
    f.sessions.get('s1')!.state = 'running';
    f.manager.receiveFrame('pc1', frame(watchId, { frameId: 'f1' }));
    f.manager.receiveFrame('pc1', frame(watchId, { frameId: 'f2', capturedAt: Date.now() + 1 }));
    expect(f.observations).toHaveLength(0);
    f.sessions.get('s1')!.state = 'idle';
    const attached = await f.manager.frameForUserTurn('s1', 'u1');
    expect(attached).toMatchObject({ frameId: 'f2', windowTitle: 'Terminal', retainFrames: 2 });
    expect(f.observations).toHaveLength(0);
  });

  it('requests a fresh frame for a user turn and resolves only its matching capture', async () => {
    const f = fixture();
    await f.manager.set('s1', 'u1', { enabled: true });
    const watchId = f.manager.current()!.watchId;
    const pending = f.manager.frameForUserTurn('s1', 'u1');
    expect(f.captures).toHaveLength(1);
    const { requestId } = f.captures[0]!.payload;
    const capture = frame(watchId, { frameId: 'fresh', capturedAt: Date.now() + 2, requestId });
    expect(f.manager.receiveFrame('pc1', capture)).toBe(true);
    expect(await pending).toMatchObject({ frameId: 'fresh', retainFrames: 2 });
    expect(f.observations).toHaveLength(0);
  });

  it('pauses capture once when the configured observation rate is exceeded', async () => {
    const f = fixture();
    await f.manager.set('s1', 'u1', { enabled: true, settings: { maxPerMinute: 1 } });
    const watchId = f.manager.current()!.watchId;
    f.manager.receiveFrame('pc1', frame(watchId, { frameId: 'f1' }));
    await Promise.resolve();
    f.manager.receiveFrame('pc1', frame(watchId, { frameId: 'f2', capturedAt: Date.now() + 1 }));
    expect(f.manager.current()).toMatchObject({ state: 'paused', reason: 'limit' });
    expect(f.controls.at(-1)?.payload.enabled).toBe(false);
    expect(f.notices).toEqual([{ sessionId: 's1', text: 'Пауза наблюдения: много изменений.' }]);
    expect(f.manager.receiveFrame('pc1', frame(watchId, { frameId: 'f3', capturedAt: Date.now() + 2 }))).toBe(false);
    expect(f.notices).toHaveLength(1);
  });

  it('auto-stops after user inactivity and resets the timer only for that user chat', async () => {
    vi.useFakeTimers();
    const start = 1_000_000;
    const f = fixture({ idleTimeoutMs: 1_000 });
    f.setNow(start);
    await f.manager.set('s1', 'u1', { enabled: true });
    vi.advanceTimersByTime(800);
    f.setNow(start + 800);
    f.manager.noteUserActivity('s2', 'u1');
    vi.advanceTimersByTime(199);
    f.setNow(start + 999);
    expect(f.manager.current()?.state).toBe('watching');
    f.setNow(start + 1_000);
    vi.advanceTimersByTime(1);
    expect(f.manager.current()).toBeUndefined();
    expect(f.statuses.at(-1)).toMatchObject({ state: 'off', reason: 'idle' });
    expect(f.notices).toEqual([{ sessionId: 's1', text: 'Наблюдение остановлено: 15 минут без активности.' }]);
  });

  it('stops on lock, kill, and offline once; stale frames cannot reactivate it', async () => {
    const f = fixture();
    await f.manager.set('s1', 'u1', { enabled: true });
    let active = f.manager.current()!;
    expect(f.manager.receiveStatus('pc1', { ...active, state: 'off', reason: 'locked' })).toBe(true);
    expect(f.manager.current()).toBeUndefined();
    expect(f.notices.at(-1)?.text).toMatch(/экран заблокирован/);
    expect(f.manager.receiveFrame('pc1', frame(active.watchId, { frameId: 'late' }))).toBe(false);

    await f.manager.set('s1', 'u1', { enabled: true });
    active = f.manager.current()!;
    f.manager.stopForUser('u1', 'killed');
    expect(f.manager.receiveStatus('pc1', { ...active, state: 'watching' })).toBe(false);
    expect(f.manager.current()).toBeUndefined();

    await f.manager.set('s1', 'u1', { enabled: true });
    f.manager.deviceOffline('pc1');
    expect(f.manager.current()).toBeUndefined();
    expect(f.notices.filter((n) => n.text.includes('офлайн'))).toHaveLength(1);
  });
});
