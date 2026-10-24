import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClipboardItem, InnerMessage } from '@pocket/protocol';
import type { WebSocketCtor } from '@pocket/transport';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const home = mkdtempSync(join(tmpdir(), 'pocket-tg-'));
process.env.POCKET_HOME = home;
process.env.POCKET_LOG_DIR = join(home, 'logs');
process.env.POCKET_NO_KEYCHAIN = '1';

const { generateIdentity, parsePairingCode, parsePairingUri, relayPaths } = await import('@pocket/protocol');
const { DeviceLink, joinAccount } = await import('@pocket/transport');
const { startNodeRelay } = await import('../../relay/src/node-server.js');
const { Brain } = await import('../../brain/src/daemon.js');
const { ensureDirs, OWNER_ID } = await import('../../brain/src/store.js');
const { PocketBot } = await import('../src/bot.js');
const { memoryStore } = await import('../src/store.js');
const { InputFile } = await import('grammy');

type Relay = Awaited<ReturnType<typeof startNodeRelay>>;
const WS = WebSocket as unknown as WebSocketCtor;

let relay: Relay;
let brain: InstanceType<typeof Brain>;
const links: InstanceType<typeof DeviceLink>[] = [];

const published = async <T extends { code: string }>(ticket: T): Promise<T> => {
  const { pairingId } = parsePairingCode(ticket.code);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL(relayPaths.pairingBundle(pairingId), relay.url));
    if (response.ok) return ticket;
    if (response.status !== 404) throw new Error(`Pairing publication returned ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for pairing publication');
};

const until = <T>(what: string, fn: (resolve: (v: T) => void) => void, ms = 10_000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms);
    fn((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });

const ME: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Pocket',
  username: 'PocketTestBot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
const USER = { id: 4242, is_bot: false, first_name: 'Masha', username: 'masha', language_code: 'en' };
const CHAT = { id: 4242, type: 'private' as const, first_name: 'Masha' };
let updateId = 0;
let messageId = 0;
const message = (extra: Record<string, unknown>): Update => ({ update_id: ++updateId, message: { message_id: ++messageId, date: 1, chat: CHAT, from: USER, ...extra } as never });
const text = (t: string, entities?: { type: 'bot_command'; offset: number; length: number }[]) => message({ text: t, ...(entities ? { entities } : {}) });
const command = (cmd: string, arg?: string) => text(arg ? `/${cmd} ${arg}` : `/${cmd}`, [{ type: 'bot_command', offset: 0, length: cmd.length + 1 }]);

/** Telegram calls the bot makes, and the canned answers it gets. */
function fakeTelegram(bot: InstanceType<typeof PocketBot>) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result: unknown =
      method === 'getFile'
        ? { file_id: (payload as { file_id: string }).file_id, file_unique_id: 'u', file_path: `photos/${(payload as { file_id: string }).file_id}.jpg` }
        : method === 'answerCallbackQuery' || method === 'editMessageText' || method === 'sendChatAction'
          ? true
          : { message_id: ++messageId, date: 1, chat: CHAT, text: '' };
    return Promise.resolve({ ok: true as const, result: result as never });
  });
  const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string);
  return { calls, texts, last: () => texts()[texts().length - 1] };
}

/** A paired Windows computer that only shares its clipboard, like PocketClipboard. */
async function fakeComputer(code: Parameters<typeof joinAccount>[0]['code'], contents: () => ClipboardItem[]) {
  const joined = await joinAccount({ relayUrl: relay.url, code, role: 'executor', name: 'masha-pc' });
  const link = new DeviceLink({
    relayUrl: relay.url,
    accountId: joined.bundle.accountId,
    deviceId: joined.deviceId,
    role: 'executor',
    identity: joined.identity,
    peers: { [joined.bundle.brainDeviceId]: joined.bundle.brainEncPub },
  });
  links.push(link);
  const written: ClipboardItem[] = [];
  const brainId = joined.bundle.brainDeviceId;
  link.on('message', ({ message: m }: { message: InnerMessage }) => {
    if (m.type === 'clipboard.read') link.send(brainId, { type: 'clipboard.data', payload: { requestId: m.payload.requestId, items: contents() } });
    if (m.type === 'clipboard.write') {
      written.push(m.payload.item);
      link.send(brainId, { type: 'clipboard.done', payload: { requestId: m.payload.requestId } });
    }
  });
  link.on('ready', () => link.send(brainId, { type: 'executor.status', payload: { workspaces: [], os: 'win32', shell: 'none', capabilities: ['clipboard'] } }));
  const ready = until<void>('pc ready', (ok) => link.on('ready', () => ok()));
  link.connect();
  await ready;
  return { deviceId: joined.deviceId, written, link };
}

beforeAll(async () => {
  ensureDirs();
  relay = await startNodeRelay({ port: 0 });
  brain = new Brain(generateIdentity(), { relayUrl: relay.url, devices: [], users: [], allowlist: [], sessions: [], replay: {} }, { persist: false });
  brain.start();
  await until<void>('brain ready', (ok) => {
    const t = setInterval(() => brain.status().relayConnected && (clearInterval(t), ok()), 25);
  });
});

afterAll(async () => {
  for (const l of links) l.close();
  brain.stop();
  await relay.close();
});

describe('PocketBot', () => {
  it('links through a phone code, moves the clipboard both ways and unlinks', async () => {
    let clipboard: ClipboardItem[] = [{ kind: 'text', text: 'hello from windows' }];
    const pcTicket = await published(brain.startPairing());
    const pc = await fakeComputer(parsePairingUri(pcTicket.uri).code, () => clipboard);
    await until<void>('pc known', (ok) => {
      const t = setInterval(() => brain.status().executorOnline && (clearInterval(t), ok()), 25);
    });

    const store = memoryStore();
    const downloads: string[] = [];
    const bot = new PocketBot({
      token: '1:test',
      relayUrl: relay.url,
      store,
      log: () => {},
      WebSocket: WS,
      botInfo: ME,
      download: async (path) => {
        downloads.push(path);
        return new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      },
    });
    const tg = fakeTelegram(bot);

    await bot.bot.handleUpdate(text('anything'));
    expect(tg.last()).toMatch(/not linked/);
    await bot.bot.handleUpdate(command('start', 'NOT-A-CODE'));
    expect(tg.last()).toMatch(/expired or is not/);

    // The phone's Settings → Telegram → Link makes this code; the user taps t.me/<bot>?start=<code>.
    const ticket = await published(brain.startPairing(undefined, { userId: OWNER_ID }));
    await bot.bot.handleUpdate(command('start', ticket.code));
    expect(tg.last()).toMatch(/^Linked as .+\nClipboard computer: masha-pc\./);
    expect(brain.status().devices.map((d) => d.name)).toContain('Telegram @masha');
    expect(Object.keys(store.load().links)).toEqual(['4242']);
    expect(bot.links).toBe(1);

    // Clipboard → Telegram: text as a message, long text as a file, an image as a photo.
    await bot.bot.handleUpdate(text('📋 Clipboard → here'));
    expect(tg.last()).toBe('hello from windows');
    clipboard = [{ kind: 'text', text: 'x'.repeat(5000) }];
    await bot.bot.handleUpdate(text('📋 Буфер → сюда'));
    const doc = tg.calls.filter((c) => c.method === 'sendDocument').pop();
    expect(doc?.payload.document).toBeInstanceOf(InputFile);
    expect((doc?.payload.document as InstanceType<typeof InputFile>).filename).toBe('clipboard.txt');
    clipboard = [{ kind: 'image', mime: 'image/png', dataBase64: Buffer.from('png').toString('base64') }];
    await bot.bot.handleUpdate(text('📋 Clipboard → here'));
    expect(tg.calls.filter((c) => c.method === 'sendPhoto')).toHaveLength(1);
    clipboard = [];
    await bot.bot.handleUpdate(text('📋 Clipboard → here'));
    expect(tg.last()).toMatch(/is empty/);

    // Telegram → clipboard: after the button, text or a photo (downloaded through getFile); a PDF is refused.
    await bot.bot.handleUpdate(text('📥 Text → clipboard'));
    await bot.bot.handleUpdate(text('paste me'));
    expect(tg.last()).toBe('Copied to masha-pc.');
    expect(pc.written).toEqual([{ kind: 'text', text: 'paste me' }]);
    await bot.bot.handleUpdate(text('🖼 Фото → в буфер'));
    await bot.bot.handleUpdate(message({ photo: [{ file_id: 'small', file_unique_id: 's', width: 10, height: 10 }, { file_id: 'big', file_unique_id: 'b', width: 100, height: 100 }] }));
    expect(downloads).toEqual(['photos/big.jpg']);
    expect(pc.written[1]).toEqual({ kind: 'image', mime: 'image/jpeg', dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') });
    await bot.bot.handleUpdate(text('🖼 Photo → clipboard'));
    await bot.bot.handleUpdate(message({ document: { file_id: 'd', file_unique_id: 'd', mime_type: 'application/pdf', file_name: 'a.pdf' } }));
    expect(tg.last()).toMatch(/Only text and pictures/);
    expect(pc.written).toHaveLength(2);
    // Without the button and without a chat, plain text is neither copied nor sent anywhere.
    await bot.bot.handleUpdate(text('just talking'));
    expect(tg.last()).toMatch(/No chat yet/);
    expect(pc.written).toHaveLength(2);

    // Status and the computer picker.
    await bot.bot.handleUpdate(command('status'));
    expect(tg.last()).toMatch(/Mac: online[\s\S]*● masha-pc ✓/);
    await bot.bot.handleUpdate(text('🖥 Computer'));
    const picker = tg.calls.filter((c) => c.method === 'sendMessage').pop()?.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    expect(picker.inline_keyboard[0]?.[0]).toEqual({ text: '● masha-pc ✓', callback_data: `pc:${pc.deviceId}` });
    await bot.bot.handleUpdate({ update_id: ++updateId, callback_query: { id: 'cq', from: USER, chat_instance: 'x', data: `pc:${pc.deviceId}`, message: { message_id: messageId, date: 1, chat: CHAT, text: 'Which computer?' } } } as never);
    expect(tg.calls.filter((c) => c.method === 'editMessageText').pop()?.payload.text).toBe('Using masha-pc.');

    // Russian speakers get Russian.
    const ru = { ...USER, id: 7, language_code: 'ru' };
    await bot.bot.handleUpdate({ update_id: ++updateId, message: { message_id: ++messageId, date: 1, chat: { ...CHAT, id: 7 }, from: ru, text: 'привет' } } as never);
    expect(tg.last()).toMatch(/не привязан/);

    // Unlink: the Mac forgets the device, the bot forgets the account.
    await bot.bot.handleUpdate(command('unlink'));
    expect(tg.last()).toMatch(/^Unlinked/);
    await until<void>('device gone', (ok) => {
      const t = setInterval(() => !brain.status().devices.some((d) => d.name === 'Telegram @masha') && (clearInterval(t), ok()), 25);
    });
    expect(store.load().links).toEqual({});
    await bot.bot.handleUpdate(text('anything'));
    expect(tg.last()).toMatch(/not linked/);
    await bot.stop();
  });

  it('reconnects saved links on start and tells phones about the bot', async () => {
    const ticket = await published(brain.startPairing(undefined, { userId: OWNER_ID }));
    const store = memoryStore();
    const first = new PocketBot({ token: '1:test', relayUrl: relay.url, store, log: () => {}, WebSocket: WS, botInfo: ME });
    const tg1 = fakeTelegram(first);
    await first.bot.handleUpdate(command('start', ticket.code));
    expect(tg1.last()).toMatch(/^Linked as/);
    await first.stop();

    const second = new PocketBot({ token: '1:test', relayUrl: relay.url, store, log: () => {}, WebSocket: WS, botInfo: ME });
    const tg = fakeTelegram(second);
    expect(second.links).toBe(1);
    await second.bot.handleUpdate(command('status'));
    expect(tg.last()).toMatch(/Mac: online/);
    await second.stop();

    // A phone asks for the deep link once the daemon knows the bot.
    brain.configureTelegram({ token: '1:test', username: ME.username });
    const phoneTicket = await published(brain.startPairing());
    const joined = await joinAccount({ relayUrl: relay.url, code: parsePairingUri(phoneTicket.uri).code, role: 'client', name: 'phone' });
    const phone = new DeviceLink({ relayUrl: relay.url, accountId: joined.bundle.accountId, deviceId: joined.deviceId, role: 'client', identity: joined.identity, peers: { [joined.bundle.brainDeviceId]: joined.bundle.brainEncPub } });
    links.push(phone);
    const inbox: InnerMessage[] = [];
    phone.on('message', ({ message: m }) => inbox.push(m));
    await until<void>('phone ready', (ok) => {
      phone.on('ready', () => ok());
      phone.connect();
    });
    phone.send(joined.bundle.brainDeviceId, { type: 'status.get', payload: {} });
    const status = await until<InnerMessage>('host.status', (ok) => {
      const t = setInterval(() => {
        const m = inbox.find((m) => m.type === 'host.status');
        if (m) (clearInterval(t), ok(m));
      }, 25);
    });
    expect(status.type === 'host.status' && status.payload.telegramBot).toBe(ME.username);
    phone.send(joined.bundle.brainDeviceId, { type: 'telegram.link', payload: {} });
    const linking = await until<InnerMessage>('telegram.linking', (ok) => {
      const t = setInterval(() => {
        const m = inbox.find((m) => m.type === 'telegram.linking');
        if (m) (clearInterval(t), ok(m));
      }, 25);
    });
    if (linking.type !== 'telegram.linking') throw new Error('unreachable');
    expect(linking.payload.url).toBe(`https://t.me/${ME.username}?start=${linking.payload.code}`);
    const third = new PocketBot({ token: '1:test', relayUrl: relay.url, store: memoryStore(), log: () => {}, WebSocket: WS, botInfo: ME });
    const tg3 = fakeTelegram(third);
    await third.bot.handleUpdate(command('start', linking.payload.code));
    expect(tg3.last()).toMatch(/^Linked as/);
    await third.stop();
  });

  it('announces the Mini App as the menu button and pairs it through /app', async () => {
    const ticket = await published(brain.startPairing(undefined, { userId: OWNER_ID }));
    const bot = new PocketBot({ token: '1:test', relayUrl: relay.url, appUrl: 'https://mac.example/', store: memoryStore(), log: () => {}, WebSocket: WS, botInfo: ME });
    const tg = fakeTelegram(bot);
    await bot.announce();
    expect(tg.calls.find((c) => c.method === 'setChatMenuButton')?.payload.menu_button).toEqual({ type: 'web_app', text: 'Pocket', web_app: { url: 'https://mac.example/' } });
    expect((tg.calls.find((c) => c.method === 'setMyCommands')?.payload.commands as { command: string }[]).map((c) => c.command)).toContain('app');

    await bot.bot.handleUpdate(command('app'));
    expect(tg.last()).toMatch(/not linked/);
    await bot.bot.handleUpdate(command('start', ticket.code));
    expect(tg.last()).toMatch(/^Linked as/);
    await bot.bot.handleUpdate(command('app'));
    expect(tg.last()).toMatch(/opens Pocket inside Telegram/);
    const markup = tg.calls.filter((c) => c.method === 'sendMessage').pop()?.payload.reply_markup as { inline_keyboard: { text: string; web_app: { url: string } }[][] };
    const button = markup.inline_keyboard[0]?.[0];
    expect(button?.text).toBe('📱 Open Pocket');
    expect(button?.web_app.url).toMatch(/^https:\/\/mac\.example\/\?code=[A-Z2-7-]+$/);

    // The Mini App joins with that code and lands with the same person as the bot.
    const code = new URL(button!.web_app.url).searchParams.get('code')!;
    const joined = await joinAccount({ relayUrl: relay.url, code: parsePairingCode(code), role: 'client', name: 'Telegram android' });
    const devices = brain.status().devices;
    expect(devices.find((d) => d.deviceId === joined.deviceId)?.user).toBe(devices.find((d) => d.name === 'Telegram @masha')?.user);
    await bot.stop();

    // Without a Mini App the menu button goes back to Telegram's default and /app is not listed.
    const plain = new PocketBot({ token: '1:test', relayUrl: relay.url, store: memoryStore(), log: () => {}, WebSocket: WS, botInfo: ME });
    const tgPlain = fakeTelegram(plain);
    await plain.announce();
    expect(tgPlain.calls.find((c) => c.method === 'setChatMenuButton')?.payload.menu_button).toEqual({ type: 'default' });
    expect((tgPlain.calls.find((c) => c.method === 'setMyCommands')?.payload.commands as { command: string }[]).map((c) => c.command)).not.toContain('app');
    await plain.stop();
  });
});
