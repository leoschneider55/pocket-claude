import type { ChatItem, PermissionRequest } from '@pocket/client-core';
import type { SessionMeta, SessionState } from '@pocket/protocol';
import type { HostToWebview, PanelState, WebviewToHost } from '../protocol.js';
import {
  formatResultLine,
  parseMarkdown,
  permissionPreview,
  prettyJson,
  shortToolName,
  summarizeTool,
  tail,
} from './format.js';

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void };

const api = acquireVsCodeApi();
const post = (m: WebviewToHost) => api.postMessage(m);

const STATE_MARK: Record<SessionState, string> = { idle: '○', running: '●', waiting_permission: '◆', ended: '×' };
const STICK_THRESHOLD_PX = 48;
const UNPAIR_CONFIRM_MS = 3000;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = h('button', `btn ${className}`.trim(), label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

const app = document.getElementById('app') as HTMLElement;

const picker = h('div', 'picker');
const selectedDot = h('span', 'dot');
const select = h('select');
select.title = 'Chats';
const newBtn = button('New chat', 'secondary', () => post({ type: 'create' }));
picker.append(selectedDot, select, newBtn);

const macDot = h('span', 'dot');
const winDot = h('span', 'dot');
const status = h('div', 'status');
const macStatus = h('span', 'status');
macStatus.append(macDot, document.createTextNode('Mac'));
const winStatus = h('span', 'status');
winStatus.append(winDot, document.createTextNode('Windows'));
status.append(macStatus, winStatus);

let unpairTimer: ReturnType<typeof setTimeout> | undefined;
const unpairBtn = button('Unpair', 'danger', () => {
  if (unpairTimer) {
    clearTimeout(unpairTimer);
    unpairTimer = undefined;
    unpairBtn.textContent = 'Unpair';
    post({ type: 'unpair' });
    return;
  }
  unpairBtn.textContent = 'Confirm?';
  unpairTimer = setTimeout(() => {
    unpairTimer = undefined;
    unpairBtn.textContent = 'Unpair';
  }, UNPAIR_CONFIRM_MS);
}, 'Disconnect this device from the Mac');
const refreshBtn = button('Refresh', '', () => post({ type: 'refresh' }), 'Reload sessions and status');
const killBtn = button('Kill all', 'danger', () => post({ type: 'kill' }), 'Stop all sessions and running commands');

const bar = h('div', 'bar');
bar.append(picker, status, refreshBtn, killBtn, unpairBtn);

const bannerText = h('span');
const banner = h('div', 'banner');
banner.append(bannerText, button('Dismiss', '', () => post({ type: 'clearError' })));
banner.hidden = true;

const thread = h('div');
thread.id = 'thread';
const perms = h('div');
perms.id = 'perms';

const input = h('textarea');
input.rows = 1;
input.placeholder = 'Message Claude (Enter to send, Shift+Enter for newline)';
const sendBtn = button('Send', 'primary', () => submit());
const stopBtn = button('Stop', 'secondary', () => {
  if (current.selected) post({ type: 'interrupt', sessionId: current.selected });
});
stopBtn.hidden = true;
const composer = h('div', 'composer');
composer.append(input, stopBtn, sendBtn);

const unpaired = h('div', 'unpaired');
unpaired.append(h('div', undefined, 'Not paired with a Mac.'), button('Pair', 'primary', () => post({ type: 'pair' })));

app.append(bar, banner, thread, perms, composer, unpaired);

let current: PanelState = { paired: false, selected: null, chat: null };
let stick = true;
let renderedSelected: string | null = null;
let optionsSig = '';
let permsSig = '';
const expanded = new Set<string>();
const cache = new Map<string, { item: ChatItem; el: HTMLElement }>();

function submit(): void {
  const text = input.value.trim();
  if (!text) return;
  stick = true;
  post({ type: 'send', sessionId: current.selected, text });
  input.value = '';
  autosize();
}

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
select.addEventListener('change', () => post({ type: 'select', sessionId: select.value }));
thread.addEventListener('scroll', () => {
  stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < STICK_THRESHOLD_PX;
});

function renderAssistant(text: string, streaming: boolean): HTMLElement {
  const root = h('div', 'msg-assistant');
  for (const block of parseMarkdown(text)) {
    if (block.type === 'code') {
      const pre = h('pre', 'block');
      pre.append(h('code', undefined, block.text));
      root.append(pre);
    } else {
      const p = h('p');
      for (const part of block.inline) p.append(part.code ? h('code', undefined, part.text) : document.createTextNode(part.text));
      root.append(p);
    }
  }
  if (streaming) {
    const last = root.lastElementChild;
    if (last) last.classList.add('caret');
    else root.append(h('p', 'caret'));
  }
  return root;
}

function labelled(parent: HTMLElement, label: string, body: string, className?: string): void {
  parent.append(h('div', 'label', label), h('pre', className, body));
}

function renderTool(item: Extract<ChatItem, { type: 'tool' }>): HTMLElement {
  const details = h('details', item.result?.isError ? 'tool err' : 'tool');
  details.open = expanded.has(item.key);
  details.addEventListener('toggle', () => {
    if (details.open) expanded.add(item.key);
    else expanded.delete(item.key);
  });
  const summary = h('summary');
  summary.append(h('span', 'tool-name', shortToolName(item.name)), h('span', 'tool-sum', summarizeTool(item.input)));
  if (!item.result) summary.append(h('span', undefined, '…'));
  const body = h('div', 'tool-body');
  labelled(body, 'Input', prettyJson(item.input));
  if (item.result) labelled(body, item.result.isError ? 'Error' : 'Result', tail(item.result.content, 8000), item.result.isError ? 'err' : undefined);
  else if (item.output) labelled(body, 'Output', tail(item.output, 4000));
  details.append(summary, body);
  return details;
}

function renderItem(item: ChatItem): HTMLElement {
  switch (item.type) {
    case 'user':
      return h('div', 'msg-user', item.text);
    case 'assistant':
      return renderAssistant(item.text, item.streaming);
    case 'tool':
      return renderTool(item);
    case 'screen_watch':
      return h('div', 'meta', item.text);
    case 'result':
      return h('div', 'meta', formatResultLine(item.durationMs, item.costUsd));
    case 'error':
      return h('div', 'error-item', item.message);
  }
}

function renderThread(items: ChatItem[], loaded: boolean): void {
  if (items.length === 0) {
    cache.clear();
    thread.replaceChildren(h('div', 'empty', loaded ? 'Start a conversation.' : 'Loading…'));
    return;
  }
  const seen = new Set<string>();
  items.forEach((item, i) => {
    seen.add(item.key);
    let entry = cache.get(item.key);
    if (!entry || entry.item !== item) {
      entry = { item, el: renderItem(item) };
      const old = cache.get(item.key);
      if (old && old.el.parentNode === thread) thread.replaceChild(entry.el, old.el);
      cache.set(item.key, entry);
    }
    if (thread.children[i] !== entry.el) thread.insertBefore(entry.el, thread.children[i] ?? null);
  });
  for (const [key, entry] of cache) {
    if (!seen.has(key)) {
      entry.el.remove();
      cache.delete(key);
    }
  }
  while (thread.children.length > items.length) thread.lastElementChild?.remove();
}

function renderOptions(sessions: SessionMeta[], selected: string | null): void {
  const sig = JSON.stringify(sessions.map((s) => [s.sessionId, s.title, s.state]));
  if (sig !== optionsSig) {
    optionsSig = sig;
    if (sessions.length === 0) {
      const o = h('option', undefined, 'No chats yet');
      o.value = '';
      select.replaceChildren(o);
    } else {
      select.replaceChildren(
        ...sessions.map((s) => {
          const o = h('option', undefined, `${STATE_MARK[s.state]} ${s.title}`);
          o.value = s.sessionId;
          return o;
        }),
      );
    }
  }
  select.value = selected ?? '';
  select.disabled = sessions.length === 0;
}

function permissionCard(p: PermissionRequest): HTMLElement {
  const card = h('div', 'perm');
  const summary = summarizeTool(p.input, 160);
  card.append(h('div', 'title', `Allow ${shortToolName(p.tool)}?`));
  if (summary) card.append(h('div', 'tool-sum', summary));
  const pre = h('pre', 'diff');
  for (const line of permissionPreview(p.tool, p.input)) {
    const prefix = line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '';
    pre.append(h('span', `diff-${line.kind}`, `${prefix}${line.text}\n`));
  }
  card.append(pre);
  const actions = h('div', 'actions');
  actions.append(
    button('Allow', 'primary', () => post({ type: 'permission', requestId: p.requestId, decision: 'allow' })),
    button('Allow for this chat', 'secondary', () => post({ type: 'permission', requestId: p.requestId, decision: 'allow_session' })),
    button('Deny', 'danger', () => post({ type: 'permission', requestId: p.requestId, decision: 'deny' })),
  );
  card.append(actions);
  return card;
}

function render(state: PanelState): void {
  current = state;
  const chat = state.chat;
  const paired = state.paired && chat !== null;
  unpaired.hidden = paired;
  for (const node of [bar, thread, composer]) node.hidden = !paired;
  if (!paired || !chat) {
    banner.hidden = true;
    perms.replaceChildren();
    permsSig = '';
    return;
  }

  macDot.className = `dot${chat.connection === 'online' && chat.brainOnline ? ' on' : ''}`;
  macStatus.title = chat.connection === 'online' ? (chat.brainOnline ? 'Mac online' : 'Mac offline') : `Relay ${chat.connection}`;
  winDot.className = `dot${chat.host?.executorOnline ? ' on' : ''}`;
  winStatus.title = chat.host?.executorOnline ? 'Windows executor online' : 'Windows executor offline';

  banner.hidden = !chat.lastError;
  bannerText.textContent = chat.lastError ?? '';

  const session = chat.sessions.find((s) => s.sessionId === state.selected);
  renderOptions(chat.sessions, state.selected);
  selectedDot.className = `dot${session ? ` ${session.state}` : ''}`;
  stopBtn.hidden = session?.state !== 'running';

  if (state.selected !== renderedSelected) {
    renderedSelected = state.selected;
    cache.clear();
    thread.replaceChildren();
    stick = true;
  }
  renderThread(state.selected ? (chat.threads[state.selected] ?? []) : [], state.selected ? chat.loaded[state.selected] === true : true);
  if (stick) thread.scrollTop = thread.scrollHeight;

  const pending = chat.permissions.filter((p) => p.sessionId === state.selected);
  const sig = pending.map((p) => p.requestId).join('|');
  if (sig !== permsSig) {
    permsSig = sig;
    perms.replaceChildren(...pending.map(permissionCard));
    if (stick) thread.scrollTop = thread.scrollHeight;
  }
}

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  if (ev.data.type === 'state') render(ev.data.state);
});

render(current);
post({ type: 'ready' });
