import { randomUUID } from 'node:crypto';
import {
  type ScreenImage,
  type ScreenWatchFrame,
  type ScreenWatchSettings,
  type ScreenWatchStatus,
} from '@pocket/protocol';

export const WATCH_SAMPLE_WIDTH = 160;
export const WATCH_SAMPLE_HEIGHT = 90;
export const WATCH_GRID_COLUMNS = 16;
export const WATCH_GRID_ROWS = 9;
export const WATCH_IDLE_TIMEOUT_MS = 15 * 60_000;
export const WATCH_SLEEP_GAP_MS = 30_000;

const BLOCK_CHANGE_THRESHOLD = 14;
const STABLE_CHANGE_RATIO = 0.01;

export interface ScreenWatchRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenWatchDifference {
  ratio: number;
  changedBlocks: number;
  region?: ScreenWatchRegion;
}

export type WatchSample =
  | { locked: true }
  | { locked: false; pixels: Uint8Array; width: number; height: number };

export type WatchCapture =
  | { locked: true }
  | { locked: false; image: ScreenImage & { mime: 'image/jpeg' }; windowTitle: string; processName: string; display: number };

export interface ScreenWatchHost {
  sample(display: number): Promise<WatchSample>;
  capture(display: number): Promise<WatchCapture>;
  isBusy?(): boolean;
}

export interface ScreenWatchControl {
  sessionId: string;
  watchId: string;
  enabled: boolean;
  settings: ScreenWatchSettings;
  goal?: string;
}

export interface ScreenWatchControllerOptions {
  deviceId: string;
  host: ScreenWatchHost;
  isOnline: () => boolean;
  sendFrame: (frame: ScreenWatchFrame) => void;
  sendStatus: (status: ScreenWatchStatus) => void;
  now?: () => number;
  log?: (message: string) => void;
}

interface ActiveWatch {
  control: ScreenWatchControl;
  lastUserActivityAt: number;
  lastSampleAt?: number;
  baseline?: Uint8Array;
  candidate?: { since: number; anchor: Uint8Array; latest: Uint8Array; region?: ScreenWatchRegion };
}

/** Compares block-level grayscale differences; one moving cursor or clock block stays below the default threshold. */
export function compareWatchSamples(
  previous: Uint8Array,
  current: Uint8Array,
  width = WATCH_SAMPLE_WIDTH,
  height = WATCH_SAMPLE_HEIGHT,
): ScreenWatchDifference {
  if (previous.length !== width * height || current.length !== width * height) {
    throw new Error(`Watch sample must contain ${width * height} grayscale pixels`);
  }

  let changedBlocks = 0;
  let minColumn = WATCH_GRID_COLUMNS;
  let minRow = WATCH_GRID_ROWS;
  let maxColumn = -1;
  let maxRow = -1;
  for (let row = 0; row < WATCH_GRID_ROWS; row++) {
    const top = Math.floor((row * height) / WATCH_GRID_ROWS);
    const bottom = Math.floor(((row + 1) * height) / WATCH_GRID_ROWS);
    for (let column = 0; column < WATCH_GRID_COLUMNS; column++) {
      const left = Math.floor((column * width) / WATCH_GRID_COLUMNS);
      const right = Math.floor(((column + 1) * width) / WATCH_GRID_COLUMNS);
      let difference = 0;
      let pixels = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const index = y * width + x;
          difference += Math.abs(previous[index]! - current[index]!);
          pixels++;
        }
      }
      if (difference / pixels < BLOCK_CHANGE_THRESHOLD) continue;
      changedBlocks++;
      minColumn = Math.min(minColumn, column);
      minRow = Math.min(minRow, row);
      maxColumn = Math.max(maxColumn, column);
      maxRow = Math.max(maxRow, row);
    }
  }

  const result: ScreenWatchDifference = { ratio: changedBlocks / (WATCH_GRID_COLUMNS * WATCH_GRID_ROWS), changedBlocks };
  if (changedBlocks > 0) {
    result.region = {
      x: minColumn / WATCH_GRID_COLUMNS,
      y: minRow / WATCH_GRID_ROWS,
      width: (maxColumn - minColumn + 1) / WATCH_GRID_COLUMNS,
      height: (maxRow - minRow + 1) / WATCH_GRID_ROWS,
    };
  }
  return result;
}

/** Owns the only watch timer. Stopping or disconnecting clears it before another screen read can be scheduled. */
export class ScreenWatchController {
  private active: ActiveWatch | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private work: Promise<unknown> = Promise.resolve();
  private lastStatus: ScreenWatchStatus | undefined;

  constructor(private readonly options: ScreenWatchControllerOptions) {}

  get status(): ScreenWatchStatus | undefined {
    return this.lastStatus;
  }

  control(control: ScreenWatchControl): void {
    if (!control.enabled) {
      if (this.active && !this.matches(this.active, control.sessionId, control.watchId)) return;
      if (this.active) this.stop('user');
      else this.publish(this.statusFor(control, 'off', 'user'));
      return;
    }

    if (this.active && this.matches(this.active, control.sessionId, control.watchId)) {
      this.active.control = control;
      this.active.baseline = undefined;
      this.active.candidate = undefined;
      this.active.lastSampleAt = undefined;
      this.clearTimer();
      const generation = ++this.generation;
      this.publish(this.statusFor(control, 'watching'));
      void this.enqueue(() => this.tick(generation));
      return;
    }

    if (this.active) this.stop('replaced');
    const now = this.now();
    this.active = { control, lastUserActivityAt: now };
    const generation = ++this.generation;
    this.publish(this.statusFor(control, 'watching'));
    void this.enqueue(() => this.tick(generation));
  }

  userActivity(sessionId: string): void {
    if (this.active?.control.sessionId === sessionId) this.active.lastUserActivityAt = this.now();
  }

  capture(sessionId: string, watchId: string, requestId: string): void {
    const active = this.active;
    if (!active || !this.matches(active, sessionId, watchId)) return;
    if (active.lastSampleAt !== undefined && this.now() - active.lastSampleAt > WATCH_SLEEP_GAP_MS && !this.options.host.isBusy?.()) {
      this.stop('sleep');
      return;
    }
    active.lastUserActivityAt = this.now();
    const generation = this.generation;
    void this.enqueue(async () => {
      this.clearTimer();
      await this.captureFrame(generation, requestId);
      if (this.isCurrent(generation)) this.schedule(generation);
    });
  }

  stop(reason: 'user' | 'idle' | 'locked' | 'sleep' | 'offline' | 'error' | 'killed' | 'replaced' = 'user'): void {
    const active = this.active;
    this.clearTimer();
    this.generation++;
    this.active = undefined;
    if (active) this.publish(this.statusFor(active.control, 'off', reason));
  }

  close(): void {
    this.stop('offline');
  }

  private async tick(generation: number): Promise<void> {
    const active = this.current(generation);
    if (!active) return;
    const now = this.now();
    if (!this.options.isOnline()) return this.stop('offline');
    if (now - active.lastUserActivityAt >= WATCH_IDLE_TIMEOUT_MS) return this.stop('idle');
    if (active.lastSampleAt !== undefined && now - active.lastSampleAt > WATCH_SLEEP_GAP_MS && !this.options.host.isBusy?.()) {
      return this.stop('sleep');
    }
    if (this.options.host.isBusy?.()) {
      this.schedule(generation);
      return;
    }

    let sample: WatchSample;
    try {
      sample = await this.options.host.sample(active.control.settings.display);
    } catch (error) {
      this.options.log?.(`screen watch sample failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.isCurrent(generation)) this.stop('error');
      return;
    }
    const current = this.current(generation);
    if (!current) return;
    current.lastSampleAt = this.now();
    if (!this.options.isOnline()) return this.stop('offline');
    if (sample.locked) return this.stop('locked');
    if (this.now() - current.lastUserActivityAt >= WATCH_IDLE_TIMEOUT_MS) return this.stop('idle');

    if (sample.pixels.length !== sample.width * sample.height) {
      this.options.log?.('screen watch returned an invalid sample');
      return this.stop('error');
    }
    if (!current.baseline) {
      current.baseline = sample.pixels;
      current.candidate = undefined;
    } else {
      const difference = compareWatchSamples(current.baseline, sample.pixels, sample.width, sample.height);
      if (difference.ratio <= current.control.settings.changeThreshold) {
        current.candidate = undefined;
      } else {
        const candidate = current.candidate;
        const stable = candidate && compareWatchSamples(candidate.anchor, sample.pixels, sample.width, sample.height).ratio <= STABLE_CHANGE_RATIO;
        if (!candidate || !stable) {
          current.candidate = { since: this.now(), anchor: sample.pixels, latest: sample.pixels, ...(difference.region ? { region: difference.region } : {}) };
        } else {
          candidate.latest = sample.pixels;
          candidate.region = difference.region;
          if (this.now() - candidate.since >= current.control.settings.settleMs) {
            await this.captureDetected(generation, candidate);
          }
        }
      }
    }
    if (this.isCurrent(generation)) this.schedule(generation);
  }

  private async captureDetected(
    generation: number,
    candidate: { since: number; anchor: Uint8Array; latest: Uint8Array; region?: ScreenWatchRegion },
  ): Promise<void> {
    const active = this.current(generation);
    if (!active || !this.options.isOnline()) return this.stop('offline');
    let capture: WatchCapture;
    try {
      capture = await this.options.host.capture(active.control.settings.display);
    } catch (error) {
      this.options.log?.(`screen watch capture failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.isCurrent(generation)) this.stop('error');
      return;
    }
    if (!this.isCurrent(generation)) return;
    if (capture.locked) return this.stop('locked');
    this.sendFrame(active, capture, candidate.region);
    if (!this.isCurrent(generation)) return;
    active.baseline = candidate.latest;
    active.candidate = undefined;
  }

  private async captureFrame(generation: number, requestId: string): Promise<void> {
    const active = this.current(generation);
    if (!active || !this.options.isOnline()) return this.stop('offline');
    let capture: WatchCapture;
    try {
      capture = await this.options.host.capture(active.control.settings.display);
    } catch (error) {
      this.options.log?.(`screen watch requested capture failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.isCurrent(generation)) this.stop('error');
      return;
    }
    if (!this.isCurrent(generation)) return;
    if (capture.locked) return this.stop('locked');
    this.sendFrame(active, capture, undefined, requestId);
    if (!this.isCurrent(generation)) return;
    try {
      const sample = await this.options.host.sample(active.control.settings.display);
      if (!this.isCurrent(generation)) return;
      if (sample.locked) return this.stop('locked');
      if (sample.pixels.length !== sample.width * sample.height) return this.stop('error');
      active.baseline = sample.pixels;
      active.candidate = undefined;
      active.lastSampleAt = this.now();
    } catch (error) {
      this.options.log?.(`screen watch baseline sample failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.isCurrent(generation)) this.stop('error');
    }
  }

  private sendFrame(active: ActiveWatch, capture: Extract<WatchCapture, { locked: false }>, region?: ScreenWatchRegion, requestId?: string): void {
    const frame: ScreenWatchFrame = {
      sessionId: active.control.sessionId,
      watchId: active.control.watchId,
      frameId: randomUUID(),
      capturedAt: this.now(),
      image: capture.image,
      windowTitle: capture.windowTitle,
      processName: capture.processName,
      display: capture.display,
      ...(region ? { changedRegion: region } : {}),
      ...(requestId ? { requestId } : {}),
    };
    try {
      this.options.sendFrame(frame);
    } catch (error) {
      this.options.log?.(`screen watch frame send failed: ${error instanceof Error ? error.message : String(error)}`);
      this.stop('offline');
    }
  }

  private schedule(generation: number): void {
    const active = this.current(generation);
    if (!active) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(() => this.tick(generation));
    }, active.control.settings.intervalMs);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.work.then(work, work);
    this.work = run.then(() => undefined, () => undefined);
    return run;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private current(generation: number): ActiveWatch | undefined {
    return this.generation === generation ? this.active : undefined;
  }

  private isCurrent(generation: number): boolean {
    return this.current(generation) !== undefined;
  }

  private matches(active: ActiveWatch, sessionId: string, watchId: string): boolean {
    return active.control.sessionId === sessionId && active.control.watchId === watchId;
  }

  private statusFor(control: ScreenWatchControl, state: ScreenWatchStatus['state'], reason?: ScreenWatchStatus['reason']): ScreenWatchStatus {
    return {
      sessionId: control.sessionId,
      watchId: control.watchId,
      deviceId: this.options.deviceId,
      state,
      ...(reason ? { reason } : {}),
      ...(control.goal ? { goal: control.goal } : {}),
      settings: control.settings,
    };
  }

  private publish(status: ScreenWatchStatus): void {
    this.lastStatus = status;
    try {
      this.options.sendStatus(status);
    } catch (error) {
      this.options.log?.(`screen watch status send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
