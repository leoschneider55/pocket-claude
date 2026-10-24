import * as os from 'node:os';
import { deserializeIdentity, type InnerMessageBody, type SerializedIdentity } from '@pocket/protocol';
import { DeviceLink, type IncomingMessage, type WebSocketCtor } from '@pocket/transport';
import type { ClipboardBackend } from './clipboard.js';
import type { ComputerBackend } from './computer.js';
import type { ScreenBackend } from './screenshot.js';

export interface AgentState {
  relayUrl: string;
  accountId: string;
  brainDeviceId: string;
  brainEncPub: string;
  deviceId: string;
  identity: SerializedIdentity;
  replay: Record<string, number>;
  /** Show AI replies in the overlay window; unset means on (Windows only). */
  overlay?: boolean;
  /** Overlay colours; unset means dark. */
  overlayTheme?: 'dark' | 'light';
  /** Lets Claude drive the mouse, keyboard and windows; unset means off, switched on only on this computer. */
  computer?: boolean;
}

/** What the overlay window needs from the agent: the brain's session traffic and its presence. */
export interface OverlaySink {
  connected(): void;
  offline(): void;
  handle(message: InnerMessageBody): void;
}

/** Shares this computer's clipboard and screen with the paired Mac and, when allowed, its mouse and keyboard; no files, no commands. */
export class ClipboardAgent {
  private readonly link: DeviceLink;
  private overlay: OverlaySink | undefined;

  constructor(
    private readonly state: AgentState,
    private readonly opts: {
      clipboard: ClipboardBackend;
      /** Screenshots on request; absent means the computer does not offer them. */
      screen?: ScreenBackend;
      /** Computer use: screen, mouse, keyboard and windows; absent means the computer does not offer it. */
      computer?: ComputerBackend;
      WebSocket?: WebSocketCtor;
      log: (m: string) => void;
      /** The relay moved; the caller persists the new address. */
      onRelayMoved: (url: string) => void;
      overlay?: OverlaySink;
    },
  ) {
    this.overlay = opts.overlay;
    this.link = new DeviceLink({
      relayUrl: state.relayUrl,
      accountId: state.accountId,
      deviceId: state.deviceId,
      role: 'executor',
      identity: deserializeIdentity(state.identity),
      peers: { [state.brainDeviceId]: state.brainEncPub },
      WebSocket: opts.WebSocket,
      replayState: state.replay,
      log: opts.log,
    });
    this.link.on('message', (m) => void this.onMessage(m));
    this.link.on('ready', (_r, online) => online.includes(state.brainDeviceId) && this.sendStatus());
    this.link.on('presence', (id, online) => {
      if (id !== state.brainDeviceId) return;
      if (online) this.sendStatus();
      else this.overlay?.offline();
    });
  }

  connect(): void {
    this.link.connect();
  }

  close(): void {
    this.link.close();
  }

  replayState(): Record<string, number> {
    return this.link.replayState();
  }

  /** Switches the overlay on or off at runtime; the Mac learns about it through the capabilities. */
  setOverlay(sink: OverlaySink | undefined): void {
    this.overlay = sink;
    if (this.link.isOnline(this.state.brainDeviceId)) this.sendStatus();
  }

  /** What the overlay asks of the brain: the session list, history, and messages typed in the window. */
  request(body: InnerMessageBody): void {
    this.send(body);
  }

  private send(body: InnerMessageBody): void {
    this.link.send(this.state.brainDeviceId, body);
  }

  private sendStatus(): void {
    const capabilities = ['clipboard', ...(this.opts.screen ? ['screenshot'] : []), ...(this.opts.computer ? ['computer'] : []), ...(this.overlay ? ['overlay'] : [])];
    this.send({ type: 'executor.status', payload: { workspaces: [], os: `${os.platform()} ${os.release()}`, shell: 'none', capabilities } });
    this.overlay?.connected();
  }

  private async onMessage({ from, message }: IncomingMessage): Promise<void> {
    if (from !== this.state.brainDeviceId) return;
    switch (message.type) {
      case 'clipboard.read': {
        const { requestId } = message.payload;
        try {
          const items = await this.opts.clipboard.read();
          this.opts.log(`clipboard read: ${items.map((i) => i.kind).join(', ') || 'empty'}`);
          this.send({ type: 'clipboard.data', payload: { requestId, items } });
        } catch (e) {
          this.send({ type: 'clipboard.data', payload: { requestId, error: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case 'clipboard.write': {
        const { requestId, item } = message.payload;
        try {
          await this.opts.clipboard.write(item);
          this.opts.log(`clipboard written: ${item.kind}`);
          this.send({ type: 'clipboard.done', payload: { requestId } });
        } catch (e) {
          this.send({ type: 'clipboard.done', payload: { requestId, error: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case 'screen.capture': {
        const { requestId } = message.payload;
        if (!this.opts.screen) return this.send({ type: 'screen.image', payload: { requestId, error: 'This computer does not take screenshots.' } });
        try {
          const image = await this.opts.screen.capture();
          this.opts.log(`screenshot sent: ${image.width}x${image.height}, ${Math.round(image.dataBase64.length / 1024)} KB`);
          this.send({ type: 'screen.image', payload: { requestId, image } });
        } catch (e) {
          this.send({ type: 'screen.image', payload: { requestId, error: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case 'computer.act': {
        const { requestId, action } = message.payload;
        if (!this.opts.computer) return this.send({ type: 'computer.done', payload: { requestId, error: 'This computer cannot be controlled: PocketClipboard runs here without computer use.' } });
        if (action.action === 'release') {
          // Not queued behind the step it is meant to stop.
          this.opts.computer.release();
          return this.send({ type: 'computer.done', payload: { requestId, text: 'Let go of all keys and mouse buttons.' } });
        }
        try {
          const result = await this.opts.computer.act(action);
          // Only the kind of step: typed text and window titles stay off the log.
          this.opts.log(`computer: ${action.action}${result.image ? ` ${result.image.width}x${result.image.height}` : ''}`);
          this.send({ type: 'computer.done', payload: { requestId, ...result } });
        } catch (e) {
          this.opts.log(`computer: ${action.action} failed: ${e instanceof Error ? e.message : String(e)}`);
          this.send({ type: 'computer.done', payload: { requestId, error: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case 'control.kill':
        this.opts.computer?.release();
        return;
      case 'tool.call':
        this.send({ type: 'tool.result', payload: { callId: message.payload.callId, content: 'This computer only shares its clipboard and screen.', isError: true } });
        return;
      case 'relay.moved':
        if (/^https?:\/\//.test(message.payload.url) && message.payload.url !== this.link.currentRelayUrl) {
          this.link.setRelayUrl(message.payload.url);
          this.opts.onRelayMoved(message.payload.url);
        }
        return;
      case 'session.event':
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
      case 'session.list.result':
      case 'session.history.result':
      // The brain answers only the overlay's own messages with errors (a chat that is gone, Claude failing to start).
      case 'error':
        this.overlay?.handle(message);
        return;
      default:
        return;
    }
  }
}
