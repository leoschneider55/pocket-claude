import { ChatClient, shortToolName, type ChatItem, type ChatState, type PairingTicket, type PermissionRequest } from '@pocket/client-core';
import { deserializeIdentity, parsePairingCode, serializeIdentity, type ClipboardItem, type Computer, type PermissionDecision, type SessionMeta } from '@pocket/protocol';
import { joinAccount, type WebSocketCtor } from '@pocket/transport';
import { Bot, GrammyError, InlineKeyboard, InputFile, Keyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { copyTargets, escapeHtml, itemPieces, permissionHtml } from './render.js';
import { ReplyStream } from './stream.js';
import { buttonFor, STRINGS, stringsFor, type Strings } from './strings.js';
import type { BotState, BotStore, Link } from './store.js';

export interface PocketBotOptions {
  token: string;
  /** Relay the bot's client devices connect through; the Mac's own relay address when the bot runs on the Mac. */
  relayUrl: string;
  /** Where the Mini App (the web build of the phone app) is served; enables the menu button and `/app`. */
  appUrl?: string;
  store: BotStore;
  log: (m: string) => void;
  WebSocket?: WebSocketCtor;
  /** Fetches a file Telegram holds for the bot (`file_path` from getFile). */
  download?: (filePath: string) => Promise<Uint8Array>;
  /** Skips getMe on start; tests pass this. */
  botInfo?: UserFromGetMe;
  /** Minimum time between edits of a streaming reply. */
  editIntervalMs?: number;
}

/** One reply being streamed: the items that follow our message in the thread, until the next user message. */
interface Turn {
  sessionId: string;
  text: string;
  /** Thread length when the message was sent; the echo of our message appears after this. */
  baseLen: number;
  stream: ReplyStream;
  sawRunning: boolean;
  done: boolean;
}

interface Linked {
  link: Link;
  client: ChatClient;
  turns: Turn[];
  /** Permission prompts shown in Telegram, by request id. */
  prompts: Map<string, { messageId: number; sessionId: string }>;
  /** The next text or photo goes to the clipboard instead of the chat. */
  pending?: { kind: 'text' | 'photo'; at: number };
  /** Finished replies with "→ PC" buttons, by the id of their last message. */
  replies: Map<number, { reply: string; code?: string }>;
  lastError: string | null;
}

const TEXT_MESSAGE_LIMIT = 4000;
const PHOTO_LIMIT = 10 * 1024 * 1024;
const READY_TIMEOUT_MS = 8_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_CHATS_LISTED = 10;
const MAX_REMEMBERED_REPLIES = 100;

/**
 * Telegram front for the paired computers' clipboard and for chats with Claude. Every Telegram account that
 * links through `/start <code>` becomes a client device of the person who made the code on their phone, so
 * it sees exactly what that phone sees and nothing else.
 */
export class PocketBot {
  readonly bot: Bot;
  private readonly linked = new Map<string, Linked>();
  private state: BotState;
  private persistTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: PocketBotOptions) {
    this.state = opts.store.load();
    this.bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : {});
    this.bot.catch((e) => opts.log(`telegram: handler failed: ${e.message}`));
    this.register();
    for (const [id, link] of Object.entries(this.state.links)) this.connect(id, link);
  }

  /** Long polling; returns when the bot stops. */
  async start(): Promise<void> {
    this.persistTimer = setInterval(() => this.persist(), 30_000);
    await this.announce();
    await this.bot.start({ onStart: (me) => this.opts.log(`telegram: @${me.username} polling, ${this.linked.size} linked`) });
  }

  async stop(): Promise<void> {
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.persist();
    for (const l of this.linked.values()) l.client.close();
    this.linked.clear();
    await this.bot.stop();
  }

  get links(): number {
    return this.linked.size;
  }

  /** The command list and the menu button: the Mini App when one is configured, Telegram's default otherwise. */
  async announce(): Promise<void> {
    const order = (['new', 'chats', 'stop', 'status', 'pc', 'app', 'unlink', 'help'] as const).filter((c) => c !== 'app' || this.opts.appUrl);
    try {
      await this.bot.api.setMyCommands(order.map((command) => ({ command, description: STRINGS.en.commands[command] })));
      await this.bot.api.setMyCommands(order.map((command) => ({ command, description: STRINGS.ru.commands[command] })), { language_code: 'ru' });
      await this.bot.api.setChatMenuButton({
        menu_button: this.opts.appUrl ? { type: 'web_app', text: STRINGS.en.menuButton, web_app: { url: this.opts.appUrl } } : { type: 'default' },
      });
    } catch (e) {
      this.opts.log(`telegram: announcing commands failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private persist(): void {
    for (const [id, l] of this.linked) {
      const link = this.state.links[id];
      if (link) link.replay = l.client.replayState();
    }
    this.opts.store.save(this.state);
  }

  private connect(id: string, link: Link): Linked {
    const client = new ChatClient({
      ...link.credentials,
      relayUrl: this.opts.relayUrl,
      followRelayMoves: false,
      identity: deserializeIdentity(link.credentials.identity),
      WebSocket: this.opts.WebSocket,
      replayState: link.replay,
      log: (m) => this.opts.log(`telegram[${id}]: ${m}`),
      onRelayMoved: (relayUrl) => {
        link.credentials.relayUrl = relayUrl;
        this.persist();
      },
    });
    const entry: Linked = { link, client, turns: [], prompts: new Map(), replies: new Map(), lastError: null };
    client.subscribe((s) => void this.onState(entry, s));
    client.connect();
    this.linked.set(id, entry);
    return entry;
  }

  private register(): void {
    const bot = this.bot;
    // Private chats only: the bot shows personal clipboards and chats.
    bot.use((ctx, next) => (ctx.chat?.type === 'private' ? next() : Promise.resolve()));

    bot.command('start', (ctx) => this.onStart(ctx, ctx.match));
    bot.command('unlink', (ctx) => this.onUnlink(ctx));
    bot.command('status', (ctx) => this.withLinked(ctx, (l, t) => this.sendStatus(ctx, l, t)));
    bot.command('pc', (ctx) => this.withLinked(ctx, (l, t) => this.pickComputer(ctx, l, t)));
    bot.command('new', (ctx) => this.withLinked(ctx, (l, t) => this.newChat(ctx, l, t, ctx.match)));
    bot.command('chats', (ctx) => this.withLinked(ctx, (l, t) => this.listChats(ctx, l, t)));
    bot.command('stop', (ctx) => this.withLinked(ctx, (l, t) => this.stopChat(ctx, l, t)));
    bot.command('app', (ctx) => this.withLinked(ctx, (l, t) => this.openApp(ctx, l, t)));
    bot.command('help', (ctx) => ctx.reply(this.t(ctx).help, { reply_markup: this.keyboard(this.t(ctx), this.linked.get(String(ctx.from?.id))) }));
    bot.callbackQuery(/^pc:(.+)$/, (ctx) =>
      this.withLinked(ctx, async (l, t) => {
        const id = ctx.match[1] ?? '';
        const pc = l.client.getState().computers.find((c) => c.deviceId === id);
        await ctx.answerCallbackQuery();
        if (!pc) return;
        l.client.selectComputer(pc.deviceId);
        await ctx.editMessageText(t.pcSet(pc.name)).catch(() => {});
      }),
    );
    bot.callbackQuery(/^copy:(code|reply):(\d+)$/, (ctx) =>
      this.withLinked(ctx, async (l, t) => {
        const what = ctx.match[1] as 'code' | 'reply';
        const remembered = l.replies.get(Number(ctx.match[2]));
        const text = what === 'code' ? remembered?.code : remembered?.reply;
        if (!text) return void (await ctx.answerCallbackQuery({ text: what === 'code' ? t.noCode : t.failed('expired'), show_alert: false }));
        const pc = this.target(l);
        if (!pc) return void (await ctx.answerCallbackQuery({ text: t.noComputer, show_alert: true }));
        if (!pc.online) return void (await ctx.answerCallbackQuery({ text: t.pcOffline(pc.name), show_alert: true }));
        try {
          await l.client.writeClipboard(pc.deviceId, { kind: 'text', text });
          await ctx.answerCallbackQuery({ text: t.sentToPc(pc.name) });
        } catch (e) {
          await ctx.answerCallbackQuery({ text: t.failed(e instanceof Error ? e.message : String(e)), show_alert: true });
        }
      }),
    );
    bot.callbackQuery(/^chat:(.+)$/, (ctx) =>
      this.withLinked(ctx, async (l, t) => {
        const id = ctx.match[1] ?? '';
        await ctx.answerCallbackQuery();
        if (id === 'new') {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          return this.newChat(ctx, l, t, '');
        }
        const session = l.client.getState().sessions.find((s) => s.sessionId === id);
        if (!session) return;
        this.setActiveSession(l, id);
        await ctx.editMessageText(t.nowIn(session.title)).catch(() => {});
      }),
    );
    bot.callbackQuery(/^perm:([^:]+):(allow|allow_session|deny)$/, (ctx) =>
      this.withLinked(ctx, async (l, t) => {
        const requestId = ctx.match[1] ?? '';
        const decision = ctx.match[2] as PermissionDecision;
        await ctx.answerCallbackQuery();
        if (!l.prompts.delete(requestId)) return;
        l.client.respondPermission(requestId, decision);
        const verdict = decision === 'allow' ? t.allowed : decision === 'allow_session' ? t.allowedSession : t.denied;
        await ctx.editMessageText(`${ctx.callbackQuery.message?.text ?? ''}\n\n${verdict}`).catch(() => {});
      }),
    );
    bot.on('message:text', (ctx) =>
      this.withLinked(ctx, async (l, t) => {
        const text = ctx.message.text;
        switch (buttonFor(text)) {
          case 'read':
            return this.readClipboard(ctx, l, t);
          // No force_reply here: it would replace the keyboard, which is the whole point of having one.
          case 'text':
            l.pending = { kind: 'text', at: Date.now() };
            return void (await ctx.reply(t.sendText, { reply_markup: this.keyboard(t, l) }));
          case 'photo':
            l.pending = { kind: 'photo', at: Date.now() };
            return void (await ctx.reply(t.sendPhoto, { reply_markup: this.keyboard(t, l) }));
          case 'screenshot':
            return this.sendScreenshot(ctx, l, t);
          case 'newChat':
            return this.newChat(ctx, l, t, '');
          case 'stop':
            return this.stopChat(ctx, l, t);
          case 'chats':
            return this.listChats(ctx, l, t);
          case 'pc':
            return this.pickComputer(ctx, l, t);
          case 'status':
            return this.sendStatus(ctx, l, t);
          default:
            if (this.takePending(l) === 'text') return this.writeClipboard(ctx, l, t, { kind: 'text', text });
            return this.sendToClaude(ctx, l, t, text);
        }
      }),
    );
    bot.on('message:photo', (ctx) =>
      this.withLinked(ctx, async (l, t) => {
        const best = ctx.message.photo[ctx.message.photo.length - 1];
        if (!best) return;
        const data = await this.fetchFile(best.file_id);
        const item: ClipboardItem = { kind: 'image', mime: 'image/jpeg', dataBase64: Buffer.from(data).toString('base64') };
        if (this.takePending(l) === 'photo') return this.writeClipboard(ctx, l, t, item);
        // No name: the brain passes unnamed images to Claude as pictures it can look at.
        return this.sendToClaude(ctx, l, t, ctx.message.caption ?? '', [{ mime: item.mime, dataBase64: item.dataBase64 }]);
      }),
    );
    bot.on('message:document', (ctx) =>
      this.withLinked(ctx, async (l, t) => {
        const doc = ctx.message.document;
        const pending = this.takePending(l);
        if (pending === 'photo' && !doc.mime_type?.startsWith('image/')) return void (await ctx.reply(t.onlyImages));
        const data = await this.fetchFile(doc.file_id);
        const mime = doc.mime_type ?? 'application/octet-stream';
        const dataBase64 = Buffer.from(data).toString('base64');
        if (pending === 'photo') return this.writeClipboard(ctx, l, t, { kind: 'image', mime, dataBase64 });
        return this.sendToClaude(ctx, l, t, ctx.message.caption ?? '', [{ mime, dataBase64, ...(doc.file_name ? { name: doc.file_name } : {}) }]);
      }),
    );
  }

  private t(ctx: Context): Strings {
    return stringsFor(this.linked.get(String(ctx.from?.id))?.link.languageCode ?? ctx.from?.language_code);
  }

  private tFor(l: Linked): Strings {
    return stringsFor(l.link.languageCode);
  }

  /** The control panel under the input: always the same, so it never has to be asked for again. One computer needs no picker. */
  private keyboard(t: Strings, l?: Linked): Keyboard {
    const kb = new Keyboard().text(t.buttons.read).text(t.buttons.screenshot).row().text(t.buttons.text).text(t.buttons.photo).row().text(t.buttons.newChat).text(t.buttons.stop);
    if ((l?.client.clipboardComputers().length ?? 0) > 1) kb.text(t.buttons.pc);
    return kb.text(t.buttons.status).resized().persistent();
  }

  private takePending(l: Linked): 'text' | 'photo' | undefined {
    const p = l.pending;
    l.pending = undefined;
    return p && Date.now() - p.at < PENDING_TTL_MS ? p.kind : undefined;
  }

  private async withLinked(ctx: Context, fn: (l: Linked, t: Strings) => Promise<void> | void): Promise<void> {
    const t = this.t(ctx);
    const l = this.linked.get(String(ctx.from?.id));
    if (!l) {
      await ctx.reply(t.notLinked);
      return;
    }
    try {
      await fn(l, t);
    } catch (e) {
      await ctx.reply(t.failed(e instanceof Error ? e.message : String(e)));
    }
  }

  private async onStart(ctx: Context, payload: string): Promise<void> {
    const t = this.t(ctx);
    const id = String(ctx.from?.id);
    const code = payload.trim();
    if (!code) {
      const l = this.linked.get(id);
      if (!l) return void (await ctx.reply(t.notLinked));
      const name = l.client.getState().host?.user?.name ?? '…';
      return void (await ctx.reply(t.linked(name, this.target(l)?.name), { reply_markup: this.keyboard(t, l) }));
    }
    let parsed;
    try {
      parsed = parsePairingCode(code);
    } catch {
      return void (await ctx.reply(t.badCode));
    }
    await ctx.reply(t.linking);
    try {
      const joined = await joinAccount({
        relayUrl: this.opts.relayUrl,
        code: parsed,
        role: 'client',
        name: `Telegram ${ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? id)}`,
        WebSocket: this.opts.WebSocket,
        timeoutMs: 20_000,
      });
      this.linked.get(id)?.client.close();
      const link: Link = {
        chatId: ctx.chat?.id ?? Number(id),
        ...(ctx.from?.username ? { username: ctx.from.username } : {}),
        ...(ctx.from?.language_code ? { languageCode: ctx.from.language_code } : {}),
        credentials: {
          relayUrl: this.opts.relayUrl,
          accountId: joined.reply.accountId,
          deviceId: joined.deviceId,
          identity: serializeIdentity(joined.identity),
          brainDeviceId: joined.reply.brainDeviceId,
          brainEncPub: joined.bundle.brainEncPub,
        },
        replay: {},
      };
      this.state.links[id] = link;
      const l = this.connect(id, link);
      this.persist();
      const state = await this.ready(l);
      this.opts.log(`telegram: linked ${id} as ${state.host?.user?.name ?? 'unknown'} (${joined.deviceId})`);
      await ctx.reply(t.linked(state.host?.user?.name ?? '…', this.target(l)?.name), { reply_markup: this.keyboard(t, l) });
    } catch (e) {
      await ctx.reply(t.linkFailed(e instanceof Error ? e.message : String(e)));
    }
  }

  private async onUnlink(ctx: Context): Promise<void> {
    const t = this.t(ctx);
    const id = String(ctx.from?.id);
    const l = this.linked.get(id);
    if (!l) return void (await ctx.reply(t.notLinked));
    l.client.unpairDevice();
    // Give the message a moment to leave before the socket closes.
    await new Promise((r) => setTimeout(r, 300));
    l.client.close();
    this.linked.delete(id);
    delete this.state.links[id];
    this.persist();
    await ctx.reply(t.unlinked, { reply_markup: { remove_keyboard: true } });
  }

  /** Waits for the Mac to answer the first status request so computers and the person are known. */
  private ready(l: Linked): Promise<ChatState> {
    return new Promise((resolve) => {
      const isReady = (s: ChatState) => s.brainOnline && s.host !== null && l.client.computersLoaded;
      const done = (s: ChatState) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(s);
      };
      const timer = setTimeout(() => done(l.client.getState()), READY_TIMEOUT_MS);
      const unsubscribe = l.client.subscribe((s) => isReady(s) && done(s));
      const now = l.client.getState();
      if (isReady(now)) done(now);
    });
  }

  /** The computer whose clipboard is used: the phone's pick, else the first online one that shares it. */
  private target(l: Linked): Computer | undefined {
    const list = l.client.clipboardComputers();
    return list.find((c) => c.online) ?? list[0];
  }

  // ---- clipboard ----

  private async readClipboard(ctx: Context, l: Linked, t: Strings): Promise<void> {
    const state = await this.ready(l);
    if (!state.brainOnline) return void (await ctx.reply(t.macOffline));
    const pc = this.target(l);
    if (!pc) return void (await ctx.reply(t.noComputer));
    if (!pc.online) return void (await ctx.reply(t.pcOffline(pc.name)));
    await ctx.replyWithChatAction('typing');
    const items = await l.client.readClipboard(pc.deviceId);
    if (!items.length) return void (await ctx.reply(t.empty(pc.name), { reply_markup: this.keyboard(t, l) }));
    for (const item of items) await this.sendItem(ctx, item, pc.name);
  }

  private async sendScreenshot(ctx: Context, l: Linked, t: Strings): Promise<void> {
    const state = await this.ready(l);
    if (!state.brainOnline) return void (await ctx.reply(t.macOffline));
    const pc = this.target(l);
    if (!pc) return void (await ctx.reply(t.noComputer));
    if (!pc.online) return void (await ctx.reply(t.pcOffline(pc.name)));
    if (!pc.capabilities?.includes('screenshot')) return void (await ctx.reply(t.noScreenshot(pc.name), { reply_markup: this.keyboard(t, l) }));
    await ctx.replyWithChatAction('upload_photo').catch(() => {});
    try {
      const image = await l.client.screenshot(pc.deviceId);
      const file = new InputFile(Buffer.from(image.dataBase64, 'base64'), image.mime === 'image/png' ? 'screen.png' : 'screen.jpg');
      await ctx.replyWithPhoto(file, { caption: t.screenshotOf(pc.name), reply_markup: this.keyboard(t, l) });
    } catch (e) {
      await ctx.reply(t.screenshotFailed(e instanceof Error ? e.message : String(e)), { reply_markup: this.keyboard(t, l) });
    }
  }

  private async sendItem(ctx: Context, item: ClipboardItem, pcName: string): Promise<void> {
    switch (item.kind) {
      case 'text':
        if (item.text.length <= TEXT_MESSAGE_LIMIT) await ctx.reply(item.text, { entities: [], link_preview_options: { is_disabled: true } });
        else await ctx.replyWithDocument(new InputFile(Buffer.from(item.text, 'utf8'), 'clipboard.txt'), { caption: pcName });
        return;
      case 'image': {
        const data = Buffer.from(item.dataBase64, 'base64');
        const file = new InputFile(data, item.mime === 'image/jpeg' ? 'clipboard.jpg' : 'clipboard.png');
        if (data.length <= PHOTO_LIMIT) await ctx.replyWithPhoto(file, { caption: pcName });
        else await ctx.replyWithDocument(file, { caption: pcName });
        return;
      }
      case 'file':
        await ctx.replyWithDocument(new InputFile(Buffer.from(item.dataBase64, 'base64'), item.name), { caption: pcName });
        return;
    }
  }

  private async writeClipboard(ctx: Context, l: Linked, t: Strings, item: ClipboardItem): Promise<void> {
    const state = await this.ready(l);
    if (!state.brainOnline) return void (await ctx.reply(t.macOffline));
    const pc = this.target(l);
    if (!pc) return void (await ctx.reply(t.noComputer));
    if (!pc.online) return void (await ctx.reply(t.pcOffline(pc.name)));
    await l.client.writeClipboard(pc.deviceId, item);
    await ctx.reply(t.copied(pc.name), { reply_markup: this.keyboard(t, l) });
  }

  private async pickComputer(ctx: Context, l: Linked, t: Strings): Promise<void> {
    await this.ready(l);
    const list = l.client.clipboardComputers();
    if (!list.length) return void (await ctx.reply(t.noComputer));
    const current = this.target(l);
    const kb = new InlineKeyboard();
    for (const c of list) kb.text(`${c.online ? '●' : '○'} ${c.name}${c.deviceId === current?.deviceId ? ' ✓' : ''}`, `pc:${c.deviceId}`).row();
    await ctx.reply(t.pickPc, { reply_markup: kb });
  }

  private async sendStatus(ctx: Context, l: Linked, t: Strings): Promise<void> {
    const s = await this.ready(l);
    const current = this.target(l);
    await ctx.reply(
      t.status({
        user: s.host?.user?.name ?? '…',
        owner: s.host?.user?.owner ?? false,
        macOnline: s.brainOnline,
        claude: s.host?.claudeVersion,
        computers: s.computers.map((c) => ({ name: c.name, online: c.online, current: c.deviceId === current?.deviceId, clipboard: c.capabilities?.includes('clipboard') ?? false })),
      }),
      { reply_markup: this.keyboard(t, l) },
    );
  }

  // ---- Mini App ----

  /** A one-tap way in: the button carries a fresh pairing code, so the app joins as another device of this person. */
  private async openApp(ctx: Context, l: Linked, t: Strings): Promise<void> {
    if (!this.opts.appUrl) return void (await ctx.reply(t.noApp));
    const state = await this.ready(l);
    if (!state.brainOnline) return void (await ctx.reply(t.macOffline));
    const ticket = await this.pairingTicket(l);
    const url = new URL(this.opts.appUrl);
    url.searchParams.set('code', ticket.code);
    await ctx.reply(t.openApp, { reply_markup: new InlineKeyboard().webApp(t.openAppButton, url.toString()) });
  }

  /** The brain's codes are role-agnostic: `computer.pair` answers with one the Mini App can join with as a client. */
  private pairingTicket(l: Linked): Promise<PairingTicket> {
    return new Promise((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        unsubscribe();
      };
      const timer = setTimeout(() => {
        stop();
        reject(new Error('the Mac did not answer'));
      }, READY_TIMEOUT_MS);
      const unsubscribe = l.client.subscribe((s) => {
        if (!s.pairing) return;
        stop();
        resolve(s.pairing);
        l.client.clearPairing();
      });
      if (!l.client.pairComputer()) {
        stop();
        reject(new Error('not connected'));
      }
    });
  }

  // ---- chat with Claude ----

  private setActiveSession(l: Linked, sessionId: string | undefined): void {
    l.link.activeSession = sessionId;
    this.persist();
  }

  private activeSession(l: Linked): SessionMeta | undefined {
    const id = l.link.activeSession;
    return id ? l.client.getState().sessions.find((s) => s.sessionId === id && !s.hidden) : undefined;
  }

  private async newChat(ctx: Context, l: Linked, t: Strings, title: string): Promise<void> {
    const state = await this.ready(l);
    if (!state.brainOnline) return void (await ctx.reply(t.macOffline));
    const id = await l.client.createSession(title.trim() || undefined);
    this.setActiveSession(l, id);
    const meta = l.client.getState().sessions.find((s) => s.sessionId === id);
    await ctx.reply(t.newChat(meta?.title ?? title), { reply_markup: this.keyboard(t, l) });
  }

  private async listChats(ctx: Context, l: Linked, t: Strings): Promise<void> {
    const state = await this.ready(l);
    const active = l.link.activeSession;
    const kb = new InlineKeyboard();
    const sessions = state.sessions.filter((s) => !s.hidden).slice(0, MAX_CHATS_LISTED);
    for (const s of sessions) kb.text(`${s.sessionId === active ? '✓ ' : ''}${s.title.slice(0, 40)}`, `chat:${s.sessionId}`).row();
    kb.text(t.newChatButton, 'chat:new');
    await ctx.reply(sessions.length ? t.chats : t.noChats, { reply_markup: kb });
  }

  private async stopChat(ctx: Context, l: Linked, t: Strings): Promise<void> {
    const session = this.activeSession(l);
    if (!session || session.state === 'idle') return void (await ctx.reply(t.nothingRunning, { reply_markup: this.keyboard(t, l) }));
    l.client.interrupt(session.sessionId);
    await ctx.reply(t.stopped, { reply_markup: this.keyboard(t, l) });
  }

  private async sendToClaude(ctx: Context, l: Linked, t: Strings, text: string, attachments?: { mime: string; dataBase64: string; name?: string }[]): Promise<void> {
    const state = await this.ready(l);
    if (!state.brainOnline) return void (await ctx.reply(t.macOffline));
    const session = this.activeSession(l);
    if (!session) return void (await ctx.reply(t.noChat, { reply_markup: this.keyboard(t, l) }));
    const body = text.trim() || (attachments?.length ? '(see attachment)' : '');
    if (!body) return;
    const baseLen = (state.threads[session.sessionId] ?? []).length;
    const chatId = ctx.chat?.id ?? l.link.chatId;
    const stream = new ReplyStream(this.sink(chatId), { waiting: t.waiting, empty: t.emptyReply }, this.opts.editIntervalMs);
    if (!l.client.send(session.sessionId, body, attachments)) return void (await ctx.reply(t.failed('not connected')));
    l.turns.push({ sessionId: session.sessionId, text: body, baseLen, stream, sawRunning: false, done: false });
    await ctx.replyWithChatAction('typing').catch(() => {});
    await stream.update([], false);
  }

  /** Telegram calls for one chat; HTML that Telegram rejects is retried as plain text. */
  private sink(chatId: number) {
    const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const unparsable = (e: unknown) => e instanceof GrammyError && /parse entities/i.test(e.description);
    return {
      send: async (html: string) => {
        try {
          return (await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })).message_id;
        } catch (e) {
          if (!unparsable(e)) throw e;
          return (await this.bot.api.sendMessage(chatId, plain(html), { link_preview_options: { is_disabled: true } })).message_id;
        }
      },
      edit: async (messageId: number, html: string) => {
        try {
          await this.bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        } catch (e) {
          if (e instanceof GrammyError && /not modified/i.test(e.description)) return;
          if (!unparsable(e)) throw e;
          await this.bot.api.editMessageText(chatId, messageId, plain(html), { link_preview_options: { is_disabled: true } });
        }
      },
    };
  }

  /** Buttons under a finished reply: its last code block and the whole reply, each one tap away from the PC clipboard. */
  private async attachCopyButtons(l: Linked, t: Strings, messageId: number | undefined, items: ChatItem[]): Promise<void> {
    if (!messageId) return;
    const targets = copyTargets(items);
    if (!targets.reply) return;
    l.replies.set(messageId, targets);
    while (l.replies.size > MAX_REMEMBERED_REPLIES) l.replies.delete(l.replies.keys().next().value as number);
    const kb = new InlineKeyboard();
    if (targets.code) kb.text(t.codeToPc, `copy:code:${messageId}`);
    kb.text(t.replyToPc, `copy:reply:${messageId}`);
    await this.bot.api.editMessageReplyMarkup(l.link.chatId, messageId, { reply_markup: kb }).catch(() => {});
  }

  /** Every change of the person's state: streams replies, shows and clears permission prompts. */
  private async onState(l: Linked, s: ChatState): Promise<void> {
    const t = this.tFor(l);
    if (s.lastError && s.lastError !== l.lastError) {
      l.lastError = s.lastError;
      // The brain refused something; the message that caused it is the turn still waiting for its echo.
      const waiting = l.turns.find((turn) => !turn.done && !this.turnItems(turn, s));
      if (waiting) {
        waiting.done = true;
        l.client.clearError();
        l.lastError = null;
        await waiting.stream.update([{ kind: 'error', text: s.lastError }], true);
      }
    }
    for (const turn of l.turns) {
      if (turn.done) continue;
      if (!s.brainOnline) {
        turn.done = true;
        await turn.stream.update([{ kind: 'error', text: t.macWentOffline }], true);
        continue;
      }
      const session = s.sessions.find((x) => x.sessionId === turn.sessionId);
      if (session && session.state !== 'idle') turn.sawRunning = true;
      const items = this.turnItems(turn, s);
      if (!items) continue;
      const ended = items.ended || items.items.some((i) => i.type === 'result' || i.type === 'error') || (turn.sawRunning && session?.state === 'idle');
      turn.done = ended;
      await turn.stream.update(items.items.flatMap(itemPieces), ended);
      if (ended) await this.attachCopyButtons(l, t, turn.stream.lastMessageId(), items.items);
    }
    l.turns = l.turns.filter((turn) => !turn.done);

    const followed = new Set([...l.turns.map((turn) => turn.sessionId), ...(l.link.activeSession ? [l.link.activeSession] : [])]);
    for (const p of s.permissions) {
      if (l.prompts.has(p.requestId) || !followed.has(p.sessionId)) continue;
      l.prompts.set(p.requestId, { messageId: 0, sessionId: p.sessionId });
      await this.showPermission(l, t, p);
    }
    for (const [requestId, prompt] of [...l.prompts]) {
      if (s.permissions.some((p) => p.requestId === requestId) || prompt.messageId === 0) continue;
      l.prompts.delete(requestId);
      await this.bot.api.editMessageReplyMarkup(l.link.chatId, prompt.messageId, { reply_markup: undefined }).catch(() => {});
      await this.bot.api.sendMessage(l.link.chatId, t.resolvedElsewhere, { reply_parameters: { message_id: prompt.messageId } }).catch(() => {});
    }
  }

  /** The items of a turn, or undefined until the brain has echoed our message. */
  private turnItems(turn: Turn, s: ChatState): { items: ChatItem[]; ended: boolean } | undefined {
    const thread = s.threads[turn.sessionId] ?? [];
    const start = thread.findIndex((it, i) => i >= turn.baseLen && it.type === 'user' && it.text === turn.text);
    if (start < 0) return undefined;
    const rest = thread.slice(start + 1);
    const next = rest.findIndex((it) => it.type === 'user');
    return next < 0 ? { items: rest, ended: false } : { items: rest.slice(0, next), ended: true };
  }

  private async showPermission(l: Linked, t: Strings, p: PermissionRequest): Promise<void> {
    const kb = new InlineKeyboard().text(t.allow, `perm:${p.requestId}:allow`).text(t.deny, `perm:${p.requestId}:deny`).row().text(t.allowSession, `perm:${p.requestId}:allow_session`);
    try {
      const sent = await this.bot.api.sendMessage(l.link.chatId, `${escapeHtml(t.permission(shortToolName(p.tool)))}\n${permissionHtml(p.tool, p.input)}`, { parse_mode: 'HTML', reply_markup: kb });
      const entry = l.prompts.get(p.requestId);
      if (entry) entry.messageId = sent.message_id;
    } catch (e) {
      l.prompts.delete(p.requestId);
      this.opts.log(`telegram: permission prompt failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async fetchFile(fileId: string): Promise<Uint8Array> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram did not return the file');
    const download = this.opts.download ?? ((path: string) => defaultDownload(this.opts.token, path));
    return download(file.file_path);
  }
}

async function defaultDownload(token: string, filePath: string): Promise<Uint8Array> {
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}
