import { parseRichInline, parseRichMarkdown, permissionPreview, shortToolName, summarizeTool, type ChatItem, type RichBlock, type RichInline } from '@pocket/client-core';

/** Telegram allows 4096 characters per message; leave room for the streaming cursor and rounding. */
export const MESSAGE_LIMIT = 4000;
export const CURSOR = ' ▍';

/** One renderable unit of a reply. Pieces are packed into messages and never split across tags. */
export type Piece =
  | { kind: 'para'; inline: RichInline[] }
  | { kind: 'quote'; inline: RichInline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'tool'; text: string; failed: boolean }
  | { kind: 'error'; text: string };

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const bold = (inline: RichInline[]): RichInline[] => inline.map((r) => ({ ...r, bold: true }));

/** Headings become bold lines, lists get their markers; Telegram has no other way to show them. */
function blockPiece(b: RichBlock): Piece {
  switch (b.type) {
    case 'code':
      return { kind: 'code', lang: b.lang, text: b.text };
    case 'heading':
      return { kind: 'para', inline: bold(b.inline) };
    case 'list':
      return {
        kind: 'para',
        inline: b.items.flatMap((item, i) => [{ text: `${i ? '\n' : ''}${b.ordered ? `${i + 1}.` : '•'} ` }, ...item]),
      };
    case 'quote':
      return { kind: 'quote', inline: b.inline };
    case 'rule':
      return { kind: 'para', inline: [{ text: '———' }] };
    case 'paragraph':
      return { kind: 'para', inline: b.inline };
  }
}

export function markdownPieces(text: string): Piece[] {
  return parseRichMarkdown(text).map(blockPiece);
}

/** What a chat item contributes to the reply: tool calls as one line, text as markdown, results nothing. */
export function itemPieces(item: ChatItem): Piece[] {
  switch (item.type) {
    case 'assistant':
      return markdownPieces(item.text);
    case 'tool':
      return [{ kind: 'tool', text: `${shortToolName(item.name)} ${summarizeTool(item.input)}`.trim(), failed: item.result?.isError === true }];
    case 'error':
      return [{ kind: 'error', text: item.message }];
    case 'screen_watch':
      return [{ kind: 'para', inline: [{ text: item.text, italic: true }] }];
    case 'user':
    case 'result':
      return [];
  }
}

export function visibleText(p: Piece): string {
  switch (p.kind) {
    case 'para':
    case 'quote':
      return p.inline.map((i) => i.text).join('');
    case 'code':
      return p.text;
    case 'tool':
      return `⚙ ${p.text}${p.failed ? ' ✗' : ''}`;
    case 'error':
      return `⚠ ${p.text}`;
  }
}

function inlineHtml(inline: RichInline[]): string {
  return inline
    .map((r) => {
      let html = escapeHtml(r.text);
      if (r.code) html = `<code>${html}</code>`;
      if (r.italic) html = `<i>${html}</i>`;
      if (r.bold) html = `<b>${html}</b>`;
      if (r.link && /^https?:\/\//.test(r.link)) html = `<a href="${escapeHtml(r.link).replace(/"/g, '&quot;')}">${html}</a>`;
      return html;
    })
    .join('');
}

export function pieceHtml(p: Piece): string {
  switch (p.kind) {
    case 'para':
      return inlineHtml(p.inline);
    case 'quote':
      return `<blockquote>${inlineHtml(p.inline)}</blockquote>`;
    case 'code':
      return p.lang ? `<pre><code class="language-${escapeHtml(p.lang).replace(/"/g, '')}">${escapeHtml(p.text)}</code></pre>` : `<pre>${escapeHtml(p.text)}</pre>`;
    case 'tool':
      return `<i>${escapeHtml(visibleText(p))}</i>`;
    case 'error':
      return escapeHtml(visibleText(p));
  }
}

/** Breaks a piece that is too long for one message along line boundaries. */
function splitPiece(p: Piece, limit: number): Piece[] {
  const text = visibleText(p);
  if (text.length <= limit) return [p];
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    current = line;
    while (current.length > limit) {
      parts.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current) parts.push(current);
  return parts.map((t) => {
    switch (p.kind) {
      case 'code':
        return { kind: 'code', lang: p.lang, text: t };
      case 'para':
        return { kind: 'para', inline: parseRichInline(t) };
      case 'quote':
        return { kind: 'quote', inline: parseRichInline(t) };
      default:
        return { kind: 'error', text: t };
    }
  });
}

/** Packs pieces into messages of at most `limit` visible characters; each message is self-contained HTML. */
export function packMessages(pieces: Piece[], limit = MESSAGE_LIMIT): string[] {
  const out: string[] = [];
  let html: string[] = [];
  let length = 0;
  const flush = () => {
    if (html.length) out.push(html.join('\n\n'));
    html = [];
    length = 0;
  };
  for (const piece of pieces.flatMap((p) => splitPiece(p, limit))) {
    const size = visibleText(piece).length;
    if (length && length + 2 + size > limit) flush();
    html.push(pieceHtml(piece));
    length += (length ? 2 : 0) + size;
  }
  flush();
  return out;
}

/** What "→ PC" puts on the clipboard: the reply as written, and its last code block. */
export function copyTargets(items: ChatItem[]): { reply: string; code?: string } {
  const replies = items.filter((i) => i.type === 'assistant').map((i) => i.text.trim()).filter(Boolean);
  const codes = replies.flatMap((text) => parseRichMarkdown(text).filter((b) => b.type === 'code').map((b) => b.text));
  const code = codes[codes.length - 1];
  return { reply: replies.join('\n\n'), ...(code !== undefined && code.trim() ? { code } : {}) };
}

/** The permission prompt: what the tool wants to do, as a diff or a command. */
export function permissionHtml(tool: string, input: unknown): string {
  const lines = permissionPreview(tool, input).map((l) => `${l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : ''}${l.text}`);
  const body = lines.join('\n').slice(0, 3000);
  return `<pre>${escapeHtml(body)}</pre>`;
}
