import { describe, expect, it } from 'vitest';
import { PC_ALLOWED_TOOLS, pcTools, pcToolsPrompt, type PcHandle } from '../src/pc-tools.js';

function handle(over: Partial<PcHandle> = {}): PcHandle {
  return {
    id: 'pc1',
    name: 'Laptop',
    online: true,
    capabilities: ['clipboard', 'screenshot', 'watch'],
    clipboardRead: async () => ({ items: [{ kind: 'text', text: 'hello' }] }),
    clipboardWrite: async () => ({}),
    screenshot: async () => ({ image: { mime: 'image/jpeg', dataBase64: 'QUJD', width: 1600, height: 900 } }),
    computer: async () => ({}),
    ...over,
  };
}

const byName = (pc: PcHandle) => Object.fromEntries(pcTools(() => pc).map((t) => [t.name, t]));

describe('pc tools', () => {
  it('are auto-allowed under the pocket MCP server name', () => {
    expect(PC_ALLOWED_TOOLS).toEqual(['mcp__pocket__pc_clipboard_read', 'mcp__pocket__pc_clipboard_write', 'mcp__pocket__pc_screenshot', 'mcp__pocket__screen_watch']);
    expect(pcToolsPrompt('Laptop')).toContain('"Laptop"');
    expect(pcToolsPrompt(undefined)).toContain('none is online');
  });

  it('read the clipboard as text, images and file notes', async () => {
    const tools = byName(
      handle({
        clipboardRead: async () => ({
          items: [
            { kind: 'text', text: 'copied' },
            { kind: 'image', mime: 'image/png', dataBase64: 'iVBORw0' },
            { kind: 'file', name: 'a.pdf', mime: 'application/pdf', dataBase64: 'AA==', size: 1 },
          ],
        }),
      }),
    );
    const r = await tools.pc_clipboard_read!.handler({}, {});
    expect(r.content).toEqual([
      { type: 'text', text: 'copied' },
      { type: 'image', data: 'iVBORw0', mimeType: 'image/png' },
      { type: 'text', text: '[Copied file: a.pdf, application/pdf, 1 bytes]' },
    ]);
  });

  it('write text and report what the user can paste', async () => {
    const written: unknown[] = [];
    const tools = byName(handle({ clipboardWrite: async (item) => (written.push(item), {}) }));
    const r = await tools.pc_clipboard_write!.handler({ text: 'npm test' }, {});
    expect(written).toEqual([{ kind: 'text', text: 'npm test' }]);
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('8 characters') });
  });

  it('return the screenshot as an image Claude can see', async () => {
    const r = await byName(handle()).pc_screenshot!.handler({}, {});
    expect(r.content).toEqual([
      { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
      { type: 'text', text: 'Screenshot of "Laptop", 1600x900, all monitors side by side.' },
    ]);
  });

  it('controls only the chat-selected watcher and passes the optional goal and settings', async () => {
    const calls: unknown[] = [];
    const tools = byName(handle({
      screenWatch: async (enabled, goal, settings) => {
        calls.push({ enabled, goal, settings });
        return { status: { sessionId: 's1', watchId: 'w1', deviceId: 'pc1', state: enabled ? 'watching' : 'off', settings: { intervalMs: 1000, changeThreshold: 0.08, settleMs: 1500, display: 0, maxPerMinute: 4, maxPerHour: 60, retainFrames: 2 } } };
      },
    }));
    const on = await tools.screen_watch!.handler({ action: 'on', goal: 'build finishes', settings: { maxPerMinute: 2 } }, {});
    const off = await tools.screen_watch!.handler({ action: 'off' }, {});
    expect(calls).toEqual([
      { enabled: true, goal: 'build finishes', settings: { maxPerMinute: 2 } },
      { enabled: false, goal: undefined, settings: undefined },
    ]);
    expect(on.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Claude смотрит экран') });
    expect(off.content[0]).toMatchObject({ type: 'text', text: 'Наблюдение экрана выключено.' });
  });

  it('explains when the screen-watch control is unavailable', async () => {
    const r = await byName(handle()).screen_watch!.handler({ action: 'on' }, {});
    expect(r).toMatchObject({ isError: true, content: [{ text: 'Screen watching is unavailable in this chat.' }] });
  });

  it('explain when there is no computer, it is offline, or too old', async () => {
    const none = await byName(handle({ id: undefined })).pc_screenshot!.handler({}, {});
    expect(none).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('No computer') }] });
    const offline = await byName(handle({ online: false })).pc_clipboard_read!.handler({}, {});
    expect(offline).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('offline') }] });
    const old = await byName(handle({ capabilities: ['clipboard'] })).pc_screenshot!.handler({}, {});
    expect(old).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('too old') }] });
    const failed = await byName(handle({ screenshot: async () => ({ error: 'boom' }) })).pc_screenshot!.handler({}, {});
    expect(failed).toMatchObject({ isError: true, content: [{ text: 'Screenshot of "Laptop" failed: boom' }] });
  });
});
