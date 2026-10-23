import type { SessionEvent } from '@pocket/protocol';

const MAX_TOOL_OUTPUT = 20_000;

export type ChatItem =
  | { type: 'user'; key: string; text: string; from: string; images?: number; files?: string[]; voice?: boolean; observation?: boolean }
  | { type: 'assistant'; key: string; text: string; streaming: boolean; observation?: boolean }
  | {
      type: 'tool';
      key: string;
      id: string;
      name: string;
      input: unknown;
      output: string;
      result?: { content: string; isError: boolean };
    }
  | { type: 'screen_watch'; key: string; at: number; text: string }
  | { type: 'result'; key: string; durationMs?: number; costUsd?: number; observation?: boolean }
  | { type: 'error'; key: string; message: string };

let seq = 0;
const key = () => `i${++seq}`;

function finalizeStreaming(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.type === 'assistant' && last.streaming) return [...items.slice(0, -1), { ...last, streaming: false }];
  return items;
}

function observationTurn(items: readonly ChatItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === 'user') return item.observation === true;
  }
  return false;
}

function isQuietObservation(text: string): boolean {
  const answer = text.trim();
  return !answer || answer.toLowerCase() === '[quiet]';
}

/** Pure reducer from Claude activity events to renderable chat items. */
export function applyEvent(items: ChatItem[], event: SessionEvent): ChatItem[] {
  switch (event.kind) {
    case 'user':
      return [...finalizeStreaming(items), { type: 'user', key: key(), text: event.text, from: event.from, ...(event.images ? { images: event.images } : {}), ...(event.files?.length ? { files: event.files } : {}), ...(event.voice ? { voice: true } : {}), ...(event.observation ? { observation: true } : {}) }];
    case 'text_delta': {
      const observation = observationTurn(items);
      const last = items[items.length - 1];
      if (last?.type === 'assistant' && last.streaming) return [...items.slice(0, -1), { ...last, text: last.text + event.text, ...(observation ? { observation: true } : {}) }];
      return [...items, { type: 'assistant', key: key(), text: event.text, streaming: true, ...(observation ? { observation: true } : {}) }];
    }
    case 'text': {
      const observation = event.observation ?? observationTurn(items);
      if (observation && isQuietObservation(event.text)) {
        const last = items[items.length - 1];
        return last?.type === 'assistant' && last.streaming ? items.slice(0, -1) : items;
      }
      const last = items[items.length - 1];
      if (last?.type === 'assistant' && last.streaming) return [...items.slice(0, -1), { ...last, text: event.text, streaming: false, ...(observation ? { observation: true } : {}) }];
      return [...items, { type: 'assistant', key: key(), text: event.text, streaming: false, ...(observation ? { observation: true } : {}) }];
    }
    case 'screen_watch':
      return [...items, { type: 'screen_watch', key: key(), at: event.at, text: event.text }];
    case 'tool_use':
      return [...finalizeStreaming(items), { type: 'tool', key: key(), id: event.id, name: event.name, input: event.input, output: '' }];
    case 'tool_output':
      return items.map((it) =>
        it.type === 'tool' && it.id === event.id ? { ...it, output: (it.output + event.chunk).slice(-MAX_TOOL_OUTPUT) } : it,
      );
    case 'tool_result':
      return items.map((it) => (it.type === 'tool' && it.id === event.id ? { ...it, result: { content: event.content, isError: event.isError } } : it));
    case 'result':
      return [...finalizeStreaming(items), { type: 'result', key: key(), durationMs: event.durationMs, costUsd: event.costUsd, ...(event.observation ?? observationTurn(items) ? { observation: true } : {}) }];
    case 'error':
      return [...finalizeStreaming(items), { type: 'error', key: key(), message: event.message }];
    case 'state':
      return event.state === 'idle' ? finalizeStreaming(items) : items;
  }
}

export function buildThread(events: SessionEvent[]): ChatItem[] {
  return events.reduce(applyEvent, [] as ChatItem[]);
}
