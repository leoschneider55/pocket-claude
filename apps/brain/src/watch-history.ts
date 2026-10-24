import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

export interface WatchFrameRef {
  uuid: string;
  contentIndex: number;
  imageIndex: number;
  imageHash: string;
  windowTitle: string;
  capturedAt: number;
}

export interface WatchTranscriptBinding {
  sessionId: string;
  transcriptPath: string;
}

interface WatchIndex {
  version: 1;
  sessionId: string;
  frames: WatchFrameRef[];
}

interface FileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}

export interface WatchCompactionPlan {
  binding: WatchTranscriptBinding;
  sourceHash: string;
  snapshot: FileSnapshot;
  output: string;
  changed: boolean;
}

const MAX_WINDOW_TITLE_LENGTH = 200;

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function cleanWindowTitle(title: string): string {
  return title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_WINDOW_TITLE_LENGTH);
}

export function createWatchFrameRef(input: {
  uuid: string;
  contentIndex: number;
  imageIndex: number;
  imageBase64: string;
  windowTitle: string;
  capturedAt: number;
}): WatchFrameRef {
  return {
    uuid: input.uuid,
    contentIndex: input.contentIndex,
    imageIndex: input.imageIndex,
    imageHash: sha256(input.imageBase64),
    windowTitle: cleanWindowTitle(input.windowTitle),
    capturedAt: input.capturedAt,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWatchFrameRef(value: unknown): value is WatchFrameRef {
  if (!isRecord(value)) return false;
  return (
    typeof value.uuid === 'string' &&
    value.uuid.length > 0 &&
    value.uuid.length <= 128 &&
    Number.isInteger(value.contentIndex) &&
    value.contentIndex >= 0 &&
    Number.isInteger(value.imageIndex) &&
    value.imageIndex >= 0 &&
    /^[0-9a-f]{64}$/.test(value.imageHash) &&
    typeof value.windowTitle === 'string' &&
    value.windowTitle.length <= MAX_WINDOW_TITLE_LENGTH &&
    Number.isFinite(value.capturedAt)
  );
}

function parseIndex(value: unknown): WatchIndex | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.sessionId !== 'string' || !Array.isArray(value.frames)) return;
  const frames = value.frames;
  if (!frames.every(isWatchFrameRef) || new Set(frames.map((frame) => frame.uuid)).size !== frames.length) return;
  return { version: 1, sessionId: value.sessionId, frames };
}

function writeIndex(path: string, index: WatchIndex): boolean {
  if (index.frames.length === 0) {
    try {
      rmSync(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  let temporary: string | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    temporary = join(dirname(path), '.' + basename(path) + '.' + randomUUID() + '.tmp');
    writeFileSync(temporary, JSON.stringify(index) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    if (temporary) rmSync(temporary, { force: true });
    return false;
  }
}

export class WatchHistory {
  private enabled = true;
  private sessionId: string | undefined;
  private storedSessionId: string | undefined;
  private transcriptPath: string | undefined;
  private frames: WatchFrameRef[] = [];

  constructor(private readonly indexPath: string) {
    if (!existsSync(indexPath)) return;
    try {
      const index = parseIndex(JSON.parse(readFileSync(indexPath, 'utf8')) as unknown);
      if (!index) {
        this.enabled = false;
        return;
      }
      this.storedSessionId = index.sessionId;
      this.frames = index.frames;
    } catch {
      this.enabled = false;
    }
  }

  beginSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.transcriptPath = undefined;
    if (!this.enabled || this.storedSessionId === sessionId) return;
    if (!writeIndex(this.indexPath, { version: 1, sessionId, frames: [] })) {
      this.enabled = false;
      return;
    }
    this.storedSessionId = sessionId;
    this.frames = [];
  }

  attachTranscript(sessionId: string, transcriptPath: string): boolean {
    if (
      !this.enabled ||
      sessionId !== this.sessionId ||
      !isAbsolute(transcriptPath) ||
      basename(transcriptPath) !== sessionId + '.jsonl'
    ) {
      return false;
    }
    this.transcriptPath = transcriptPath;
    return true;
  }

  binding(): WatchTranscriptBinding | undefined {
    if (!this.enabled || !this.sessionId || !this.transcriptPath) return;
    return { sessionId: this.sessionId, transcriptPath: this.transcriptPath };
  }

  record(frame: WatchFrameRef): boolean {
    if (!this.enabled || !this.sessionId || !isWatchFrameRef(frame) || this.frames.some((item) => item.uuid === frame.uuid)) return false;
    const next = [...this.frames, frame];
    const index = { version: 1 as const, sessionId: this.sessionId, frames: next };
    if (!writeIndex(this.indexPath, index)) return false;
    this.storedSessionId = this.sessionId;
    this.frames = next;
    return true;
  }

  framesToCompact(retainBeforeNewFrame: number): WatchFrameRef[] {
    if (!this.enabled || !Number.isFinite(retainBeforeNewFrame)) return [];
    const keep = Math.max(0, Math.floor(retainBeforeNewFrame));
    return this.frames.slice(0, Math.max(0, this.frames.length - keep));
  }

  forget(frames: WatchFrameRef[]): boolean {
    if (!this.enabled || !this.sessionId || frames.length === 0) return false;
    const ids = new Set(frames.map((frame) => frame.uuid));
    const next = this.frames.filter((frame) => !ids.has(frame.uuid));
    if (next.length === this.frames.length) return false;
    if (!writeIndex(this.indexPath, { version: 1, sessionId: this.sessionId, frames: next })) return false;
    this.storedSessionId = this.sessionId;
    this.frames = next;
    return true;
  }

  destroy(): void {
    this.transcriptPath = undefined;
    this.frames = [];
    this.sessionId = undefined;
    this.storedSessionId = undefined;
    rmSync(this.indexPath, { force: true });
  }
}

function frameMarker(frame: WatchFrameRef): string {
  return '[кадр экрана: ' + frame.windowTitle + ', ' + new Date(frame.capturedAt).toISOString() + ']';
}

function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function snapshot(path: string): FileSnapshot | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      mode: stat.mode & 0o777,
    };
  } catch {
    return;
  }
}

function matchesSnapshot(path: string, expected: FileSnapshot, expectedHash: string): boolean {
  const current = snapshot(path);
  if (
    !current ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.ctimeMs !== expected.ctimeMs
  ) {
    return false;
  }
  try {
    return sha256(readFileSync(path)) === expectedHash;
  } catch {
    return false;
  }
}

export function prepareWatchCompaction(
  binding: WatchTranscriptBinding,
  frames: WatchFrameRef[],
): WatchCompactionPlan | undefined {
  if (
    !binding.sessionId ||
    !isAbsolute(binding.transcriptPath) ||
    basename(binding.transcriptPath) !== binding.sessionId + '.jsonl' ||
    frames.length === 0
  ) {
    return;
  }
  const fileSnapshot = snapshot(binding.transcriptPath);
  if (!fileSnapshot) return;

  let source: Buffer;
  try {
    source = readFileSync(binding.transcriptPath);
  } catch {
    return;
  }
  const text = source.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(source)) return;

  const targets = new Map<string, WatchFrameRef>();
  for (const frame of frames) {
    if (!isWatchFrameRef(frame) || targets.has(frame.uuid)) return;
    targets.set(frame.uuid, frame);
  }

  const found = new Set<string>();
  const output: string[] = [];
  let changed = false;
  for (const line of splitLines(text)) {
    const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
    const raw = ending ? line.slice(0, -ending.length) : line;
    if (!raw.trim()) {
      output.push(line);
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isRecord(record) || typeof record.type !== 'string') return;

    const uuid = typeof record.uuid === 'string' ? record.uuid : undefined;
    const frame = uuid ? targets.get(uuid) : undefined;
    if (!frame) {
      output.push(line);
      continue;
    }
    if (found.has(frame.uuid) || record.type !== 'user' || record.parent_tool_use_id != null || !isRecord(record.message)) return;
    const content = record.message.content;
    if (record.message.role !== 'user' || !Array.isArray(content) || frame.contentIndex >= content.length) return;
    const block = content[frame.contentIndex];
    if (!isRecord(block)) return;
    const imageIndex = content
      .slice(0, frame.contentIndex)
      .filter((item: unknown) => isRecord(item) && item.type === 'image').length;
    if (imageIndex !== frame.imageIndex) return;

    const marker = frameMarker(frame);
    if (block.type === 'image') {
      if (!isRecord(block.source) || block.source.type !== 'base64' || block.source.media_type !== 'image/jpeg' || typeof block.source.data !== 'string') return;
      if (sha256(block.source.data) !== frame.imageHash) return;
      content[frame.contentIndex] = { type: 'text', text: marker };
      changed = true;
      output.push(JSON.stringify(record) + ending);
    } else if (block.type === 'text' && block.text === marker) {
      output.push(line);
    } else {
      return;
    }
    found.add(frame.uuid);
  }

  if (found.size !== targets.size) return;
  return {
    binding,
    sourceHash: sha256(source),
    snapshot: fileSnapshot,
    output: output.join(''),
    changed,
  };
}

export function applyWatchCompaction(plan: WatchCompactionPlan): boolean {
  if (!matchesSnapshot(plan.binding.transcriptPath, plan.snapshot, plan.sourceHash)) return false;
  if (!plan.changed) return true;

  let temporary: string | undefined;
  try {
    temporary = join(dirname(plan.binding.transcriptPath), '.' + basename(plan.binding.transcriptPath) + '.' + randomUUID() + '.tmp');
    writeFileSync(temporary, plan.output, { mode: plan.snapshot.mode });
    chmodSync(temporary, plan.snapshot.mode);
    if (!matchesSnapshot(plan.binding.transcriptPath, plan.snapshot, plan.sourceHash)) {
      rmSync(temporary, { force: true });
      return false;
    }
    renameSync(temporary, plan.binding.transcriptPath);
    return true;
  } catch {
    if (temporary) rmSync(temporary, { force: true });
    return false;
  }
}
