import { applyEvent, buildThread, parseRichMarkdown, type ChatItem, type RichBlock } from '@pocket/client-core';
import { DEFAULT_SCREEN_WATCH_SETTINGS, type InnerMessageBody, type ScreenWatchStatus, type SessionMeta, type SessionState } from '@pocket/protocol';
import { actionTitle, attachmentsAction, groupOf, runState, toolAction, type ActionState, type OverlayAction, type ToolItem } from './actions.js';

export type OverlayTheme = 'dark' | 'light';
/** idle: done or nothing going on; busy: Claude works; wait: approval needed on the phone; offline: the Mac is gone. */
export type OverlayTone = 'idle' | 'busy' | 'wait' | 'offline';

/** One entry of the transcript the way the window draws it. Tool calls in a row arrive as one 'actions' entry. */
export type OverlayMessage =
  | {
      id: string;
      role: 'user';
      /** Raw text, for copying. */
      text: string;
      blocks: RichBlock[];
      /** Spoken on a call. */
      voice?: boolean;
      attachments?: OverlayAction;
    }
  | {
      id: string;
      role: 'assistant';
      /** Raw text: what "copy reply" puts on the clipboard. */
      text: string;
      blocks: RichBlock[];
      streaming: boolean;
      /** Claude's first words after the user's message: the window puts the "Claude" caption over it. */
      first: boolean;
    }
  | { id: string; role: 'actions'; actions: OverlayAction[]; state: ActionState; group?: { label: string; summary: string } }
  | { id: string; role: 'error'; text: string };

export interface OverlayStatus {
  text: string;
  tone: OverlayTone;
  watching?: boolean;
}

/** One chat in the window's side list. */
export interface OverlayChat {
  id: string;
  title: string;
  /** The user's last message, on one line. */
  preview: string;
  /** "14:05", "вчера", "12 окт", or what the chat is busy with. */
  when: string;
  tone: OverlayTone;
  active: boolean;
}

export type WindowOp =
  | {
      op: 'reset';
      /** The chat on screen; the window keeps opened rows while it stays the same. */
      chatId: string | null;
      title: string;
      status: OverlayStatus;
      messages: OverlayMessage[];
      chats: OverlayChat[];
      /** Its history is still on the way. */
      loading: boolean;
      theme: OverlayTheme;
    }
  | { op: 'upsert'; message: OverlayMessage }
  | { op: 'title'; title: string }
  | { op: 'status'; status: OverlayStatus }
  | { op: 'chats'; chats: OverlayChat[] }
  | { op: 'theme'; theme: OverlayTheme }
  /** The brain put the message typed in the window into the chat. */
  | { op: 'sent'; text: string }
  /** It did not: the window keeps the text and shows why. */
  | { op: 'unsent'; text: string; error: string }
  /** Trouble after a message went in, such as Claude failing to start. */
  | { op: 'notice'; text: string }
  | { op: 'quit' };

export interface OverlayModelDeps {
  window: (op: WindowOp) => void;
  /** Requests to the brain: session.list, session.history and message.send. */
  request: (body: InnerMessageBody) => void;
  /** Clock for the times in the chat list. */
  now?: () => number;
}

const NO_CHAT = 'Чатов пока нет';
/** How long a typed message may wait for the brain to put it into the chat. */
export const SEND_TIMEOUT_MS = 15_000;
const NO_REPLY = 'Mac не ответил, сообщение не отправлено. Если так каждый раз — обновите и перезапустите brain на Mac.';
const OFFLINE = 'Mac не в сети, сообщение не отправлено';

/**
 * Follows the chat the phone is using (or the one picked in the window), turns its events into drawing ops and passes on
 * what the user writes in the window.
 */
export class OverlayModel {
  private readonly sessions = new Map<string, SessionMeta>();
  private readonly watchBySession = new Map<string, ScreenWatchStatus>();
  private readonly threads = new Map<string, ChatItem[]>();
  private readonly loaded = new Set<string>();
  private readonly requested = new Set<string>();
  private activeId: string | null = null;
  private theme: OverlayTheme = 'dark';
  private macOnline = true;
  /** What the window shows now, so unchanged status and chat lists are not resent on every streamed word. */
  private shownStatus = '';
  private shownChats = '';
  /** A message typed in the window, until the brain records it as the chat's next user message. */
  private pending: { chatId: string; text: string; timer: ReturnType<typeof setTimeout> } | undefined;

  constructor(
    private readonly deps: OverlayModelDeps,
    theme?: OverlayTheme,
  ) {
    if (theme) this.theme = theme;
  }

  /** The window reports a toggle; the agent persists it and the next snapshot carries it. */
  setTheme(theme: OverlayTheme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.deps.window({ op: 'theme', theme });
  }

  /** The Mac is reachable (again): start over from its list of chats. */
  connected(): void {
    this.macOnline = true;
    this.loaded.clear();
    this.requested.clear();
    this.pushStatus();
    this.deps.request({ type: 'session.list', payload: {} });
  }

  offline(): void {
    this.macOnline = false;
    this.unsent(OFFLINE);
    this.pushStatus();
  }

  /** The user wrote in the window: the text goes into the chat like a message typed on the phone. */
  send(chatId: string, text: string): void {
    const body = text.trim();
    if (this.pending) return this.deps.window({ op: 'unsent', text: body, error: 'Предыдущее сообщение ещё отправляется' });
    const error = !body ? 'Пустое сообщение' : !this.macOnline ? OFFLINE : !this.sessions.has(chatId) ? 'Этого чата больше нет' : undefined;
    if (error) return this.deps.window({ op: 'unsent', text: body, error });
    this.pending = { chatId, text: body, timer: setTimeout(() => this.unsent(NO_REPLY), SEND_TIMEOUT_MS) };
    this.deps.request({ type: 'message.send', payload: { sessionId: chatId, text: body } });
  }

  toggleWatch(): void {
    if (!this.activeId) return;
    const status = this.watchBySession.get(this.activeId) ?? this.sessions.get(this.activeId)?.watch;
    const enabled = status?.state !== 'watching' && status?.state !== 'paused';
    this.deps.request({
      type: 'screen.watch.set',
      payload: { sessionId: this.activeId, enabled, ...(enabled ? { settings: DEFAULT_SCREEN_WATCH_SETTINGS } : {}) },
    });
  }

  /** The user picked a chat in the window's list. */
  open(sessionId: string): void {
    if (sessionId === this.activeId || !this.sessions.has(sessionId)) return;
    this.activate(sessionId);
  }

  /** Everything the window needs to draw itself from scratch. */
  snapshot(): WindowOp {
    const id = this.activeId;
    const meta = id ? this.sessions.get(id) : undefined;
    const thread = id ? this.threads.get(id) : undefined;
    const status = this.status();
    const chats = this.chats();
    this.shownStatus = JSON.stringify(status);
    this.shownChats = JSON.stringify(chats);
    return {
      op: 'reset',
      chatId: id,
      title: meta?.title ?? NO_CHAT,
      status,
      messages: thread ? toMessages(thread, meta?.state) : [],
      chats,
      loading: !!id && !this.loaded.has(id),
      theme: this.theme,
    };
  }

  handle(message: InnerMessageBody): void {
    switch (message.type) {
      case 'session.list.result':
        this.sessions.clear();
        for (const s of message.payload.sessions) if (!s.hidden) this.sessions.set(s.sessionId, s);
        // After a reconnect the chat being read stays on screen.
        if (this.activeId && this.sessions.has(this.activeId)) this.activate(this.activeId);
        else this.pickActive();
        return;
      case 'session.created': {
        const s = message.payload.session;
        if (s.hidden) return;
        this.sessions.set(s.sessionId, s);
        // The phone just opened it: that is where the next messages go.
        this.activate(s.sessionId);
        return;
      }
      case 'session.updated': {
        const s = message.payload.session;
        if (s.hidden) {
          this.sessions.delete(s.sessionId);
          if (this.activeId === s.sessionId) this.pickActive();
          else this.pushChats();
          return;
        }
        const before = this.sessions.get(s.sessionId);
        this.sessions.set(s.sessionId, s);
        if (s.sessionId === this.activeId) {
          if (before?.title !== s.title) this.deps.window({ op: 'title', title: s.title });
          if (before?.state !== s.state) this.stateChanged(s.sessionId);
          this.pushStatus();
        }
        this.pushChats();
        return;
      }
      case 'session.deleted': {
        const id = message.payload.sessionId;
        this.sessions.delete(id);
        this.threads.delete(id);
        this.loaded.delete(id);
        this.requested.delete(id);
        if (this.activeId === id) {
          this.activeId = null;
          this.pickActive();
        } else this.pushChats();
        return;
      }
      case 'session.history.result': {
        const { sessionId, events } = message.payload;
        this.requested.delete(sessionId);
        this.threads.set(sessionId, buildThread(events));
        this.loaded.add(sessionId);
        if (sessionId === this.activeId) this.deps.window(this.snapshot());
        return;
      }
      case 'session.event': {
        const { sessionId, event } = message.payload;
        const meta = this.sessions.get(sessionId);
        const stateChanged = event.kind === 'state' && !!meta && meta.state !== event.state;
        if (meta) {
          this.sessions.set(sessionId, { ...meta, updatedAt: this.now(), ...(event.kind === 'state' ? { state: event.state } : {}) });
          if (event.kind === 'user' && sessionId !== this.activeId) this.activate(sessionId);
        }
        const before = this.threads.get(sessionId) ?? [];
        const after = applyEvent(before, event);
        this.threads.set(sessionId, after);
        if (sessionId === this.activeId && this.loaded.has(sessionId)) {
          this.redraw(sessionId, before, after);
          if (stateChanged) this.stateChanged(sessionId);
          this.pushStatus();
        }
        this.pushChats();
        // The brain records what it was sent word for word: seeing it come back means it is in the chat.
        const p = this.pending;
        if (p && event.kind === 'user' && sessionId === p.chatId && event.text === p.text) {
          clearTimeout(p.timer);
          this.pending = undefined;
          this.deps.window({ op: 'sent', text: p.text });
        }
        return;
      }
      case 'error': {
        const { code, message: text } = message.payload;
        const error = code === 'unknown_session' ? 'Этого чата нет на Mac' : code === 'claude_failed' ? `Claude не запустился: ${text}` : text;
        if (this.pending) this.unsent(error);
        else this.deps.window({ op: 'notice', text: error });
        return;
      }
      default:
        return;
    }
  }

  private unsent(error: string): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = undefined;
    this.deps.window({ op: 'unsent', text: p.text, error });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The reducer keeps untouched items by reference, so a reference change marks exactly what to redraw. */
  private redraw(id: string, before: ChatItem[], after: ChatItem[]): void {
    const changed = new Set(after.filter((item, i) => item !== before[i]));
    if (!changed.size) return;
    for (const m of toMessages(after, this.sessions.get(id)?.state, (items) => items.some((it) => changed.has(it)))) this.deps.window({ op: 'upsert', message: m });
  }

  /** Calls without a result read differently once Claude stops or waits for approval. */
  private stateChanged(id: string): void {
    const thread = this.threads.get(id);
    if (!thread || id !== this.activeId || !this.loaded.has(id)) return;
    const open = (items: ChatItem[]) => items.some((it) => it.type === 'tool' && !it.result);
    for (const m of toMessages(thread, this.sessions.get(id)?.state, open)) this.deps.window({ op: 'upsert', message: m });
  }

  private status(): OverlayStatus {
    if (!this.macOnline) return { text: 'Mac не в сети', tone: 'offline' };
    const meta = this.activeId ? this.sessions.get(this.activeId) : undefined;
    if (!meta) return { text: '', tone: 'idle' };
    return sessionStatus(meta.state, this.threads.get(meta.sessionId) ?? []);
  }

  private chats(): OverlayChat[] {
    const now = this.now();
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => chatEntry(s, s.sessionId === this.activeId, now));
  }

  private pushStatus(): void {
    const status = this.status();
    const shown = JSON.stringify(status);
    if (shown === this.shownStatus) return;
    this.shownStatus = shown;
    this.deps.window({ op: 'status', status });
  }

  private pushChats(): void {
    const chats = this.chats();
    const shown = JSON.stringify(chats);
    if (shown === this.shownChats) return;
    this.shownChats = shown;
    this.deps.window({ op: 'chats', chats });
  }

  /** Shows the most recently used chat. */
  private pickActive(): void {
    const best = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!best) {
      this.activeId = null;
      this.deps.window(this.snapshot());
      return;
    }
    this.activate(best.sessionId);
  }

  private activate(id: string): void {
    this.activeId = id;
    this.deps.window(this.snapshot());
    if (this.loaded.has(id) || this.requested.has(id)) return;
    this.requested.add(id);
    this.deps.request({ type: 'session.history', payload: { sessionId: id } });
  }
}

const parsed = new WeakMap<ChatItem, RichBlock[]>();

/** Markdown is parsed once per item: a streamed reply is a new item on every word, the rest of the chat is not. */
function blocksOf(item: Extract<ChatItem, { type: 'user' | 'assistant' }>): RichBlock[] {
  let blocks = parsed.get(item);
  if (!blocks) {
    blocks = parseRichMarkdown(item.text);
    parsed.set(item, blocks);
  }
  return blocks;
}

type Single = Extract<ChatItem, { type: 'user' | 'assistant' | 'error' }>;
type Segment = { kind: 'single'; item: Single; first: boolean } | { kind: 'run'; items: ToolItem[]; live: boolean };

function lastUserIndex(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]?.type === 'user') return i;
  return -1;
}

/**
 * What the window draws for a chat: tool calls in a row become one 'actions' entry named after the first of them, so
 * the entry keeps its id while the run grows. `only` picks the entries to build (the ones an event touched).
 */
export function toMessages(items: ChatItem[], state?: SessionState, only?: (items: ChatItem[]) => boolean): OverlayMessage[] {
  const turnStart = lastUserIndex(items);
  const working = state === 'running' || state === 'waiting_permission';
  const segments: Segment[] = [];
  let run: ToolItem[] | undefined;
  let replied = false;
  items.forEach((item, i) => {
    if (item.type === 'tool') {
      if (run) run.push(item);
      else {
        run = [item];
        // Only calls of the turn in progress can still be running; older ones without a result were cut off.
        segments.push({ kind: 'run', items: run, live: working && i > turnStart });
      }
      return;
    }
    run = undefined;
    if (item.type === 'result') return;
    if (item.type === 'user') replied = false;
    segments.push({ kind: 'single', item, first: item.type === 'assistant' && !replied });
    if (item.type === 'assistant') replied = true;
  });
  // The permission request is not mirrored here; the newest call without a result is the one waiting for it.
  const waiting = state === 'waiting_permission' ? [...items].reverse().find((it): it is ToolItem => it.type === 'tool' && !it.result)?.key : undefined;
  const out: OverlayMessage[] = [];
  for (const seg of segments) {
    if (only && !only(seg.kind === 'run' ? seg.items : [seg.item])) continue;
    out.push(segmentMessage(seg, waiting));
  }
  return out;
}

function segmentMessage(seg: Segment, waiting: string | undefined): OverlayMessage {
  if (seg.kind === 'run') {
    const actions = seg.items.map((it) => toolAction(it, it.key === waiting ? 'waiting' : seg.live ? 'running' : 'stopped'));
    const group = groupOf(actions);
    return { id: seg.items[0]!.key, role: 'actions', actions, state: runState(actions), ...(group ? { group } : {}) };
  }
  const item = seg.item;
  switch (item.type) {
    case 'user': {
      const attachments = attachmentsAction(item);
      return { id: item.key, role: 'user', text: item.text, blocks: blocksOf(item), ...(item.voice ? { voice: true } : {}), ...(attachments ? { attachments } : {}) };
    }
    case 'assistant':
      return { id: item.key, role: 'assistant', text: item.text, blocks: blocksOf(item), streaming: item.streaming, first: seg.first };
    case 'error':
      return { id: item.key, role: 'error', text: item.message };
  }
}

/** The header line: what Claude is doing in the chat on screen. */
export function sessionStatus(state: SessionState, thread: ChatItem[]): OverlayStatus {
  switch (state) {
    case 'waiting_permission':
      return { text: 'ждёт разрешения на телефоне', tone: 'wait' };
    case 'running': {
      const turnStart = lastUserIndex(thread);
      for (let i = thread.length - 1; i > turnStart; i--) {
        const it = thread[i];
        if (it?.type === 'tool' && !it.result) return { text: `выполняет: ${actionTitle(it)}`, tone: 'busy' };
      }
      const last = thread[thread.length - 1];
      if (last?.type === 'assistant' && last.streaming) return { text: 'пишет ответ…', tone: 'busy' };
      return { text: 'думает…', tone: 'busy' };
    }
    case 'ended':
      return { text: 'чат завершён', tone: 'idle' };
    default:
      return { text: 'готово', tone: 'idle' };
  }
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Local time of the last activity: "14:05" today, then "вчера", "12 окт", "12.10.2025". */
export function whenLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, n)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (same(d, new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1))) return 'вчера';
  if (d.getFullYear() === n.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function chatEntry(s: SessionMeta, active: boolean, now: number): OverlayChat {
  const wait = s.state === 'waiting_permission';
  const busy = s.state === 'running';
  return {
    id: s.sessionId,
    title: s.title,
    preview: (s.lastText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    when: wait ? 'ждёт разрешения' : busy ? 'работает…' : whenLabel(s.updatedAt, now),
    tone: wait ? 'wait' : busy ? 'busy' : 'idle',
    active,
  };
}
