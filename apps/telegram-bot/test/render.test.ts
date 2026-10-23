import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyTargets, itemPieces, markdownPieces, packMessages, permissionHtml, type Piece } from '../src/render.js';
import { ReplyStream } from '../src/stream.js';

describe('render', () => {
  it('renders screen-watch notices as escaped service text', () => {
    const pieces = itemPieces({ type: 'screen_watch', key: 'watch', at: 1, text: '👁 изменение на экране: <Build>' });
    expect(packMessages(pieces)).toEqual(['<i>👁 изменение на экране: &lt;Build&gt;</i>']);
  });

  it('turns markdown into escaped Telegram HTML', () => {
    const pieces = markdownPieces('Use `a<b` here\n\n```py\nprint("<hi>")\n```');
    expect(packMessages(pieces)).toEqual(['Use <code>a&lt;b</code> here\n\n<pre><code class="language-py">print("&lt;hi&gt;")</code></pre>']);
  });

  it('shows headings, lists, quotes, bold, italic and links the way Telegram can', () => {
    const md = ['## Plan', '', '- **run** `npm test`', '- see [docs](https://x.y/z)', '', '1. first', '2. *second*', '', '> note'].join('\n');
    expect(packMessages(markdownPieces(md))).toEqual([
      ['<b>Plan</b>', '• <b>run</b> <code>npm test</code>\n• see <a href="https://x.y/z">docs</a>', '1. first\n2. <i>second</i>', '<blockquote>note</blockquote>'].join('\n\n'),
    ]);
  });

  it('picks what the "→ PC" buttons copy: the reply and its last code block', () => {
    const reply = { type: 'assistant' as const, key: 'a', text: 'Run:\n```sh\nnpm i\n```\nthen\n```sh\nnpm test\n```', streaming: false };
    expect(copyTargets([reply, { type: 'tool', key: 't', id: 't', name: 'x', input: {}, output: '' }])).toEqual({ reply: reply.text, code: 'npm test' });
    expect(copyTargets([{ type: 'assistant', key: 'b', text: 'just words', streaming: false }])).toEqual({ reply: 'just words' });
    expect(copyTargets([])).toEqual({ reply: '' });
  });

  it('renders tool calls as one italic line and errors with a warning sign', () => {
    expect(itemPieces({ type: 'tool', key: 'k', id: 't', name: 'mcp__pocket__run_command', input: { command: 'dir' }, output: '', result: { content: '', isError: true } })).toEqual([
      { kind: 'tool', text: 'run_command dir', failed: true },
    ]);
    expect(packMessages([{ kind: 'tool', text: 'read_file a.txt', failed: false }, { kind: 'error', text: 'boom <x>' }])).toEqual(['<i>⚙ read_file a.txt</i>\n\n⚠ boom &lt;x&gt;']);
    expect(itemPieces({ type: 'result', key: 'r' })).toEqual([]);
  });

  it('packs pieces into messages under the limit and splits long code blocks by line', () => {
    const line = 'x'.repeat(90);
    const code: Piece = { kind: 'code', lang: '', text: Array(5).fill(line).join('\n') };
    const chunks = packMessages([{ kind: 'para', inline: [{ text: 'intro' }] }, code, { kind: 'para', inline: [{ text: 'outro' }] }], 200);
    expect(chunks).toEqual([`intro\n\n<pre>${line}\n${line}</pre>`, `<pre>${line}\n${line}</pre>`, `<pre>${line}</pre>\n\noutro`]);
    for (const c of chunks) expect(c.replace(/<[^>]+>/g, '').length).toBeLessThanOrEqual(200);
  });

  it('previews a permission as a diff', () => {
    expect(permissionHtml('edit_file', { file_path: 'a.ts', old_string: 'x<y', new_string: 'z' })).toBe('<pre>- x&lt;y\n+ z</pre>');
  });
});

function fakeSink() {
  const calls: string[] = [];
  let id = 0;
  return {
    calls,
    sink: {
      send: async (html: string) => {
        calls.push(`send ${html}`);
        return ++id;
      },
      edit: async (messageId: number, html: string) => {
        calls.push(`edit ${messageId} ${html}`);
      },
    },
  };
}

describe('ReplyStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a placeholder, edits at most once per interval, and finalises without the cursor', async () => {
    const { sink, calls } = fakeSink();
    const stream = new ReplyStream(sink, { waiting: '…', empty: '(nothing)' }, 1000);
    await stream.update([], false);
    expect(calls).toEqual(['send … ▍']);
    void stream.update(markdownPieces('Hel'), false);
    void stream.update(markdownPieces('Hello'), false);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[1]).toBe('edit 1 Hello ▍');
    await stream.update(markdownPieces('Hello world'), true);
    expect(calls[2]).toBe('edit 1 Hello world');
    expect(calls).toHaveLength(3);
  });

  it('continues in a new message once the current one is full', async () => {
    const { sink, calls } = fakeSink();
    const stream = new ReplyStream(sink, { waiting: '…', empty: '(nothing)' }, 0);
    const a = 'a'.repeat(3000);
    const b = 'b'.repeat(3000);
    await stream.update(markdownPieces(a), false);
    await stream.update(markdownPieces(`${a}\n\n${b}`), false);
    await stream.update(markdownPieces(`${a}\n\n${b}\n\ndone`), true);
    expect(calls).toEqual([`send ${a} ▍`, `edit 1 ${a}`, `send ${b} ▍`, `edit 2 ${b}\n\ndone`]);
  });

  it('shows the empty placeholder when a turn ends without text', async () => {
    const { sink, calls } = fakeSink();
    const stream = new ReplyStream(sink, { waiting: '…', empty: '(nothing)' }, 0);
    await stream.update([], false);
    await stream.update([], true);
    expect(calls).toEqual(['send … ▍', 'edit 1 (nothing)']);
  });
});
