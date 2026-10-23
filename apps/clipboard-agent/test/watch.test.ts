import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCREEN_WATCH_SETTINGS } from '@pocket/protocol';
import {
  compareWatchSamples,
  ScreenWatchController,
  WATCH_GRID_COLUMNS,
  WATCH_GRID_ROWS,
  WATCH_IDLE_TIMEOUT_MS,
  WATCH_SLEEP_GAP_MS,
  WATCH_SAMPLE_HEIGHT,
  WATCH_SAMPLE_WIDTH,
  type ScreenWatchHost,
  type WatchSample,
} from '../src/watch.js';

const blank = (value = 0) => new Uint8Array(WATCH_SAMPLE_WIDTH * WATCH_SAMPLE_HEIGHT).fill(value);

function blocks(sample: Uint8Array, selected: number[]): Uint8Array {
  const changed = sample.slice();
  for (const index of selected) {
    const column = index % WATCH_GRID_COLUMNS;
    const row = Math.floor(index / WATCH_GRID_COLUMNS);
    for (let y = row * 10; y < (row + 1) * 10; y++) {
      for (let x = column * 10; x < (column + 1) * 10; x++) changed[y * WATCH_SAMPLE_WIDTH + x] = 255;
    }
  }
  return changed;
}

function watchHost(read: () => WatchSample): ScreenWatchHost & { sample: ReturnType<typeof vi.fn>; capture: ReturnType<typeof vi.fn> } {
  return {
    sample: vi.fn(async () => read()),
    capture: vi.fn(async () => ({
      locked: false as const,
      image: { mime: 'image/jpeg' as const, dataBase64: 'aGVsbG8=', width: 1280, height: 720 },
      windowTitle: 'Editor',
      processName: 'editor',
      display: 0,
    })),
  };
}

function makeController(host: ScreenWatchHost, sendFrame = vi.fn(), sendStatus = vi.fn()) {
  const controller = new ScreenWatchController({
    deviceId: 'device-1',
    host,
    isOnline: () => true,
    sendFrame,
    sendStatus,
  });
  return { controller, sendFrame, sendStatus };
}

const control = (overrides: Partial<Parameters<ScreenWatchController['control']>[0]> = {}) => ({
  sessionId: 'session-1',
  watchId: 'watch-1',
  enabled: true,
  settings: { ...DEFAULT_SCREEN_WATCH_SETTINGS, intervalMs: 500, settleMs: 1000 },
  ...overrides,
});

afterEach(() => vi.useRealTimers());

describe('screen watch change detector', () => {
  it('measures changed grid blocks and returns a normalized changed region', () => {
    const difference = compareWatchSamples(blank(), blocks(blank(), [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]));
    expect(difference.ratio).toBe(12 / 144);
    expect(difference.region).toEqual({ x: 1 / 16, y: 1 / 9, width: 12 / 16, height: 1 / 9 });
    expect(compareWatchSamples(blank(), blocks(blank(), [0])).changedBlocks).toBe(0);
    expect(compareWatchSamples(blank(), blocks(blank(), [0, 15, 128, 143])).changedBlocks).toBe(0);
  });

  it('recognizes a notification-sized area and a terminal text line after noise filtering', async () => {
    vi.useFakeTimers();
    const threshold = 0.03;
    const cases = [
      Array.from({ length: 3 }, (_, row) => [18 + row * 16, 19 + row * 16, 20 + row * 16]).flat(),
      Array.from({ length: 8 }, (_, i) => 48 + i),
    ];
    for (const change of cases) {
      let pixels: Uint8Array = blank();
      const host = watchHost(() => ({ locked: false, pixels, width: WATCH_SAMPLE_WIDTH, height: WATCH_SAMPLE_HEIGHT }));
      const { controller, sendFrame } = makeController(host);
      controller.control(control({ settings: { ...DEFAULT_SCREEN_WATCH_SETTINGS, intervalMs: 500, settleMs: 1000, changeThreshold: threshold } }));
      await vi.advanceTimersByTimeAsync(0);
      pixels = blocks(blank(), change);
      await vi.advanceTimersByTimeAsync(2500);
      expect(compareWatchSamples(blank(), pixels).ratio).toBeGreaterThan(threshold);
      expect(sendFrame).toHaveBeenCalledTimes(1);
      controller.stop();
    }
  });

  it('sends one full frame only after a significant change has settled', async () => {
    vi.useFakeTimers();
    let pixels: Uint8Array = blank();
    const host = watchHost(() => ({ locked: false, pixels, width: WATCH_SAMPLE_WIDTH, height: WATCH_SAMPLE_HEIGHT }));
    const { controller, sendFrame } = makeController(host);
    controller.control(control());
    await vi.advanceTimersByTimeAsync(0);
    pixels = blocks(blank(), Array.from({ length: 12 }, (_, i) => 17 + i));

    await vi.advanceTimersByTimeAsync(1499);
    expect(host.capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(host.capture).toHaveBeenCalledTimes(1);
    expect(sendFrame).toHaveBeenCalledTimes(1);
    expect(sendFrame.mock.calls[0]![0]).toMatchObject({
      sessionId: 'session-1',
      watchId: 'watch-1',
      windowTitle: 'Editor',
      processName: 'editor',
      display: 0,
      changedRegion: { x: 1 / 16, y: 1 / 9, width: 12 / 16, height: 1 / 9 },
      image: { mime: 'image/jpeg', width: 1280, height: 720 },
    });
    controller.stop();
  });

  it('ignores a single moving block and does not capture a locked desktop', async () => {
    vi.useFakeTimers();
    let pixels: Uint8Array = blocks(blank(), [0]);
    const host = watchHost(() => ({ locked: false, pixels, width: WATCH_SAMPLE_WIDTH, height: WATCH_SAMPLE_HEIGHT }));
    const { controller, sendStatus } = makeController(host);
    controller.control(control());
    await vi.advanceTimersByTimeAsync(0);
    pixels = blank();
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.capture).not.toHaveBeenCalled();

    host.sample.mockImplementationOnce(async () => ({ locked: true }));
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.status).toMatchObject({ state: 'off', reason: 'locked' });
    expect(host.capture).not.toHaveBeenCalled();
    expect(sendStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'off', reason: 'locked' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the same safe capture path for a fresh user-turn frame', async () => {
    vi.useFakeTimers();
    const host = watchHost(() => ({ locked: false, pixels: blank(), width: WATCH_SAMPLE_WIDTH, height: WATCH_SAMPLE_HEIGHT }));
    const { controller, sendFrame } = makeController(host);
    controller.control(control());
    await vi.advanceTimersByTimeAsync(0);
    controller.capture('session-1', 'watch-1', 'request-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(sendFrame).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'request-1' }));
    expect(host.capture).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('stops after a suspend-sized gap and when the paired brain goes offline', async () => {
    vi.useFakeTimers();
    const host = watchHost(() => ({ locked: false, pixels: blank(), width: WATCH_SAMPLE_WIDTH, height: WATCH_SAMPLE_HEIGHT }));
    const { controller } = makeController(host);
    controller.control(control());
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + WATCH_SLEEP_GAP_MS + 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.status).toMatchObject({ state: 'off', reason: 'sleep' });
    expect(host.sample).toHaveBeenCalledTimes(1);

    let online = true;
    const offline = new ScreenWatchController({
      deviceId: 'device-1',
      host,
      isOnline: () => online,
      sendFrame: vi.fn(),
      sendStatus: vi.fn(),
    });
    vi.setSystemTime(0);
    offline.control(control());
    await vi.advanceTimersByTimeAsync(0);
    online = false;
    const samples = host.sample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(offline.status).toMatchObject({ state: 'off', reason: 'offline' });
    expect(host.sample).toHaveBeenCalledTimes(samples);
  });

  it('clears the polling timer on disable and auto-stops after 15 idle minutes', async () => {
    vi.useFakeTimers();
    const host = watchHost(() => ({ locked: false, pixels: blank(), width: WATCH_SAMPLE_WIDTH, height: WATCH_SAMPLE_HEIGHT }));
    const { controller, sendStatus } = makeController(host);
    controller.control(control());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.control(control({ enabled: false }));
    expect(vi.getTimerCount()).toBe(0);
    const samplesAfterDisable = host.sample.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.sample).toHaveBeenCalledTimes(samplesAfterDisable);

    controller.control(control({ settings: { ...DEFAULT_SCREEN_WATCH_SETTINGS, intervalMs: 3000 } }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WATCH_IDLE_TIMEOUT_MS);
    expect(controller.status).toMatchObject({ state: 'off', reason: 'idle' });
    expect(sendStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'off', reason: 'idle' }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
