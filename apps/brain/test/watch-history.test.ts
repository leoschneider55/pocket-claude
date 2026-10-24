import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyWatchCompaction,
  createWatchFrameRef,
  prepareWatchCompaction,
  WatchHistory,
} from '../src/watch-history.js';

const base = join((process.env.TMPDIR ?? '/tmp').replace(/\/+$/, ''), 'pocket-watch-history-test-' + process.pid);

function image(data: string) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
}

function userFrame(uuid: string, data: string, content: unknown[] = [image(data), { type: 'text', text: 'question' }]) {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    message: { role: 'user', content },
    timestamp: '2026-10-24T00:00:00.000Z',
  };
}

function frameRef(uuid: string, data: string, windowTitle = 'Editor', capturedAt = 123) {
  return createWatchFrameRef({
    uuid,
    contentIndex: 0,
    imageIndex: 0,
    imageBase64: data,
    windowTitle,
    capturedAt,
  });
}

mkdirSync(base, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('screen-watch transcript retention', () => {
  it('retains only N newest watch images', () => {
    const sessionId = randomUUID();
    const transcriptPath = join(base, sessionId + '.jsonl');
    const history = new WatchHistory(join(base, sessionId + '.watch-history.json'));
    history.beginSession(sessionId);
    expect(history.attachTranscript(sessionId, transcriptPath)).toBe(true);

    const refs = [];
    const records = [];
    for (let i = 0; i < 4; i++) {
      const data = Buffer.from('frame-' + i).toString('base64');
      const uuid = randomUUID();
      const ref = frameRef(uuid, data, 'Window ' + i, 1000 + i);
      refs.push(ref);
      expect(history.record(ref)).toBe(true);
      records.push(JSON.stringify(userFrame(uuid, data)));
    }
    writeFileSync(transcriptPath, records.join('\n') + '\n');

    const trim = history.framesToCompact(2);
    expect(trim.map((frame) => frame.uuid)).toEqual(refs.slice(0, 2).map((frame) => frame.uuid));
    const plan = prepareWatchCompaction(history.binding()!, trim);
    expect(plan).toBeDefined();
    expect(applyWatchCompaction(plan!)).toBe(true);
    expect(history.forget(trim)).toBe(true);

    const messages = readFileSync(transcriptPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(messages.slice(0, 2).every((message) => message.message.content[0].type === 'text')).toBe(true);
    expect(messages.slice(2).every((message) => message.message.content[0].type === 'image')).toBe(true);
    expect(history.framesToCompact(2)).toEqual([]);
  });

  it('replaces only the indexed watch image and preserves attachments and tool screenshots byte-for-byte', () => {
    const sessionId = randomUUID();
    const transcriptPath = join(base, sessionId + '.jsonl');
    const data = Buffer.from('same-image-bytes').toString('base64');
    const watchUuid = randomUUID();
    const watch = userFrame(watchUuid, data, [image(data), image(data), { type: 'text', text: 'What is on screen?' }]);
    const manual = userFrame(randomUUID(), data);
    const zoom = {
      type: 'assistant',
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'zoom-1', name: 'mcp__pocket__computer', input: { action: 'zoom' } }] },
    };
    const zoomResult = {
      type: 'user',
      uuid: randomUUID(),
      parent_tool_use_id: 'zoom-1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'zoom-1', content: [image(data)] }],
      },
    };
    const watchLine = JSON.stringify(watch);
    const manualLine = '  ' + JSON.stringify(manual) + '  ';
    const zoomLine = JSON.stringify(zoom);
    const zoomResultLine = JSON.stringify(zoomResult);
    writeFileSync(transcriptPath, [watchLine, manualLine, zoomLine, zoomResultLine].join('\r\n') + '\r\n');

    const plan = prepareWatchCompaction(
      { sessionId, transcriptPath },
      [frameRef(watchUuid, data)],
    );
    expect(plan).toBeDefined();
    expect(applyWatchCompaction(plan!)).toBe(true);

    const lines = readFileSync(transcriptPath, 'utf8').split('\r\n');
    const compacted = JSON.parse(lines[0]!);
    expect(compacted.message.content).toEqual([
      { type: 'text', text: '[кадр экрана: Editor, 1970-01-01T00:00:00.123Z]' },
      image(data),
      { type: 'text', text: 'What is on screen?' },
    ]);
    expect(lines[1]).toBe(manualLine);
    expect(lines[2]).toBe(zoomLine);
    expect(lines[3]).toBe(zoomResultLine);
    expect(existsSync(transcriptPath)).toBe(true);
  });

  it('fails safely on stale paths and malformed transcript lines', () => {
    const oldSessionId = randomUUID();
    const currentSessionId = randomUUID();
    const stalePath = join(base, oldSessionId + '.jsonl');
    const indexPath = join(base, 'stale-watch-index.json');
    const data = Buffer.from('watch').toString('base64');
    const uuid = randomUUID();
    const ref = frameRef(uuid, data);
    const staleText = JSON.stringify(userFrame(uuid, data)) + '\n';
    writeFileSync(stalePath, staleText);

    const oldHistory = new WatchHistory(indexPath);
    oldHistory.beginSession(oldSessionId);
    expect(oldHistory.record(ref)).toBe(true);
    const resumedHistory = new WatchHistory(indexPath);
    resumedHistory.beginSession(currentSessionId);
    expect(resumedHistory.attachTranscript(oldSessionId, stalePath)).toBe(false);
    expect(resumedHistory.binding()).toBeUndefined();
    expect(prepareWatchCompaction({ sessionId: currentSessionId, transcriptPath: stalePath }, [ref])).toBeUndefined();
    expect(readFileSync(stalePath, 'utf8')).toBe(staleText);

    const malformedPath = join(base, currentSessionId + '.jsonl');
    const malformedText = JSON.stringify(userFrame(uuid, data)) + '\nnot-json\n';
    writeFileSync(malformedPath, malformedText);
    expect(prepareWatchCompaction({ sessionId: currentSessionId, transcriptPath: malformedPath }, [ref])).toBeUndefined();
    expect(readFileSync(malformedPath, 'utf8')).toBe(malformedText);
  });
});
