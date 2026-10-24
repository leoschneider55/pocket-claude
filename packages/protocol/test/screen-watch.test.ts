import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCREEN_WATCH_SETTINGS,
  innerMessageBodySchema,
  screenWatchFrameSchema,
  screenWatchSettingsSchema,
} from '../src/index.js';

const settings = { ...DEFAULT_SCREEN_WATCH_SETTINGS };
const status = { sessionId: 'chat', watchId: 'generation', deviceId: 'pc', state: 'watching', settings };
const frame = {
  sessionId: 'chat', watchId: 'generation', frameId: 'frame', capturedAt: 123,
  image: { mime: 'image/jpeg', dataBase64: 'QUJD', width: 1280, height: 800 },
  windowTitle: 'Build — Terminal', processName: 'WindowsTerminal', display: 0,
  changedRegion: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 },
};

describe('screen observation protocol', () => {
  it('supplies conservative defaults without defaulting missing patch fields', () => {
    expect(screenWatchSettingsSchema.parse({})).toEqual({
      intervalMs: 1000, changeThreshold: 0.08, settleMs: 1500, display: 0,
      maxPerMinute: 4, maxPerHour: 60, retainFrames: 2,
    });
    const message = innerMessageBodySchema.parse({
      type: 'screen.watch.set', payload: { sessionId: 'chat', enabled: true, settings: { display: 1 } },
    });
    expect(message.payload).toEqual({ sessionId: 'chat', enabled: true, settings: { display: 1 } });
  });

  it.each([
    { type: 'screen.watch.set', payload: { sessionId: 'chat', enabled: true, goal: 'Скажи, когда закончится сборка' } },
    { type: 'screen.watch.set', payload: { sessionId: 'chat', enabled: false } },
    { type: 'screen.watch.control', payload: { sessionId: 'chat', watchId: 'generation', enabled: true, settings } },
    { type: 'screen.watch.control', payload: { sessionId: 'chat', watchId: 'generation', enabled: false, settings } },
    { type: 'screen.watch.capture', payload: { sessionId: 'chat', watchId: 'generation', requestId: 'fresh-frame' } },
    { type: 'screen.watch.frame', payload: frame },
    { type: 'screen.watch.frame', payload: { ...frame, requestId: 'fresh-frame' } },
    { type: 'screen.watch.status', payload: status },
    { type: 'screen.watch.status', payload: { ...status, state: 'paused', reason: 'limit' } },
    { type: 'screen.watch.status', payload: { ...status, state: 'off', reason: 'locked' } },
    { type: 'executor.status', payload: { os: 'win32', shell: 'none', workspaces: [], capabilities: ['watch'], watch: status } },
    { type: 'session.event', payload: { sessionId: 'chat', event: { kind: 'screen_watch', at: 123, text: '👁 изменение на экране: Terminal' } } },
    { type: 'session.event', payload: { sessionId: 'chat', event: { kind: 'text', text: 'Сборка закончилась.', observation: true } } },
    { type: 'session.event', payload: { sessionId: 'chat', event: { kind: 'result', observation: true } } },
  ])('round-trips $type', (message) => {
    expect(innerMessageBodySchema.parse(message)).toEqual(message);
  });

  it('preserves status in session metadata', () => {
    const session = { sessionId: 'chat', title: 'Test', state: 'idle', createdAt: 1, updatedAt: 2, watch: status };
    const message = { type: 'session.updated', payload: { session } };
    expect(innerMessageBodySchema.parse(message)).toEqual(message);
  });

  it.each([
    { intervalMs: 499 }, { intervalMs: 3001 }, { intervalMs: 500.5 },
    { changeThreshold: 0 }, { changeThreshold: 1.01 }, { changeThreshold: Number.NaN },
    { settleMs: 499 }, { settleMs: 5001 }, { display: -1 }, { display: 0.5 },
    { maxPerMinute: 0 }, { maxPerMinute: 5 }, { maxPerHour: 61 }, { maxPerHour: 0 },
    { retainFrames: 0 }, { retainFrames: 11 },
  ])('rejects unsafe settings %j', (patch) => {
    expect(screenWatchSettingsSchema.safeParse({ ...settings, ...patch }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'screen.watch.set', payload: { sessionId: 'chat', enabled: true, settings: patch } }).success).toBe(false);
  });

  it.each([
    { watchId: '' }, { frameId: '' }, { capturedAt: -1 }, { capturedAt: Infinity },
    { display: -1 }, { image: { ...frame.image, width: 1281 } },
    { image: { ...frame.image, height: 801 } }, { image: { ...frame.image, mime: 'image/png' } },
    { image: { ...frame.image, dataBase64: '' } },
    { changedRegion: { x: 0.75, y: 0, width: 0.5, height: 1 } },
    { changedRegion: { x: 0, y: 0, width: 0, height: 1 } },
    { windowTitle: 'x'.repeat(2049) }, { processName: 'x'.repeat(261) },
  ])('rejects malformed observation frame %#', (patch) => {
    expect(screenWatchFrameSchema.safeParse({ ...frame, ...patch }).success).toBe(false);
  });

  it('bounds observation payloads and goals', () => {
    expect(screenWatchFrameSchema.safeParse({ ...frame, image: { ...frame.image, dataBase64: 'A'.repeat(4_000_001) } }).success).toBe(false);
    expect(innerMessageBodySchema.safeParse({ type: 'screen.watch.set', payload: { sessionId: 'chat', enabled: true, goal: 'x'.repeat(1001) } }).success).toBe(false);
  });

  it('does not limit ordinary full-resolution screenshots or zoom', () => {
    const image = { mime: 'image/png', dataBase64: 'QUJD', width: 7680, height: 4320 };
    for (const type of ['screen.image', 'computer.done', 'screen.result']) {
      const payload = { requestId: 'r', ...(type === 'screen.result' ? { deviceId: 'pc' } : {}), image };
      expect(innerMessageBodySchema.parse({ type, payload })).toEqual({ type, payload });
    }
  });
});
