import { b64, DEFAULT_SCREEN_WATCH_SETTINGS, deriveDeviceId, generateIdentity, type InnerMessageBody, type ScreenWatchStatus, type SessionMeta } from '@pocket/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ChatClient } from '../src/chat-client.js';

function makeClient() {
  const identity = generateIdentity();
  const brain = generateIdentity();
  const brainDeviceId = deriveDeviceId(brain.signPub);
  const client = new ChatClient({
    relayUrl: 'http://127.0.0.1:1',
    accountId: 'acc',
    deviceId: deriveDeviceId(identity.signPub),
    identity,
    brainDeviceId,
    brainEncPub: b64.encode(brain.encPub),
  });
  const deliver = (message: unknown) =>
    (client as unknown as { onMessage: (m: { from: string; message: unknown }) => void }).onMessage({ from: brainDeviceId, message });
  const request = vi.spyOn(client as unknown as { request: (body: InnerMessageBody) => boolean }, 'request').mockReturnValue(true);
  return { client, deliver, request };
}

function session(executorId = 'pc-selected', watch?: ScreenWatchStatus): SessionMeta {
  return {
    sessionId: 'chat-1',
    title: 'Claude',
    state: 'idle',
    createdAt: 1,
    updatedAt: 1,
    executorId,
    ...(watch ? { watch } : {}),
  };
}

function watchStatus(state: ScreenWatchStatus['state'] = 'watching'): ScreenWatchStatus {
  return { sessionId: 'chat-1', watchId: 'watch-1', deviceId: 'pc-selected', state, settings: { ...DEFAULT_SCREEN_WATCH_SETTINGS } };
}

function pc(deviceId: string) {
  return { deviceId, name: deviceId, online: true, workspaces: [], capabilities: ['watch'], pairedAt: 1 };
}

describe('ChatClient screen watch', () => {
  it('targets only the chat and never substitutes another PC for a missing explicit selection', () => {
    const { client, deliver, request } = makeClient();
    client.hydrate({ sessions: [session()], threads: {} });
    deliver({ type: 'computers.result', payload: { computers: [pc('pc-selected'), pc('pc-default')], activeId: 'pc-default' } });

    expect(client.canWatchScreen('chat-1')).toBe(true);
    expect(client.setScreenWatch('chat-1', true, { goal: 'Build ends', settings: { intervalMs: 1500 } })).toBe(true);
    expect(request).toHaveBeenCalledWith({
      type: 'screen.watch.set',
      payload: { sessionId: 'chat-1', enabled: true, goal: 'Build ends', settings: { intervalMs: 1500 } },
    });

    client.hydrate({ sessions: [session('pc-missing')], threads: {} });
    expect(client.canWatchScreen('chat-1')).toBe(false);
    expect(client.setScreenWatch('chat-1', true)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('applies a live status received before the session list and preserves it through history and snapshot hydration', () => {
    const { client, deliver } = makeClient();
    const status = watchStatus('paused');
    deliver({ type: 'screen.watch.status', payload: status });
    deliver({ type: 'session.list.result', payload: { sessions: [session()] } });
    expect(client.getState().sessions[0]?.watch).toEqual(status);

    deliver({ type: 'session.history.result', payload: { sessionId: 'chat-1', events: [{ kind: 'screen_watch', at: 2, text: 'Изменение на экране: Telegram' }] } });
    expect(client.getState().threads['chat-1']?.[0]).toMatchObject({ type: 'screen_watch', text: 'Изменение на экране: Telegram' });

    const restored = makeClient().client;
    restored.hydrate(client.snapshot());
    expect(restored.getState().sessions[0]?.watch).toEqual(status);
    expect(restored.getState().threads['chat-1']?.[0]).toMatchObject({ type: 'screen_watch', text: 'Изменение на экране: Telegram' });
  });

  it('turns off each active watch before sending the kill switch', () => {
    const { client, request } = makeClient();
    client.hydrate({ sessions: [session('pc-selected', watchStatus())], threads: {} });

    expect(client.kill()).toBe(true);
    expect(request.mock.calls.map(([body]) => body.type)).toEqual(['screen.watch.set', 'control.kill']);
    expect(request.mock.calls[0]?.[0]).toEqual({ type: 'screen.watch.set', payload: { sessionId: 'chat-1', enabled: false } });
  });
});
