import { shortToolName, summarizeTool, type ChatItem, type PermissionRequest } from '@pocket/client-core';
import type { PermissionDecision, SessionState } from '@pocket/protocol';

// ---------------------------------------------------------------------------------------------------------------
// Text helpers

/** Strips what makes no sense read aloud: fences, inline code marks, list markers, emphasis. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/```[\s\S]*$/, ' ')
    // Inline code with a path or a link is not read at all; a short command is.
    .replace(/`[^`]*[/\\][^`]*`/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|__|(?<!\w)[*_](?!\s)|(?<!\s)[*_](?!\w)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'ссылка')
    .replace(/[A-Za-z]:\\[^\s"'«»,;]*[^\s"'«»,;.]|(?<!\w)(?:~|\.{1,2})?(?:\/[\w.-]*\w){2,}\/?/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([,.;:!?…])/g, '$1')
    .replace(/\n[ \n]+/g, '\n')
    .trim();
}

/**
 * The part of a reply said aloud: the text before the first code block, table, heading, `---` rule or list of more
 * than two items. That and everything after it stays in the chat, whatever the model was asked to do. `code` is the
 * language of the code block the reply was cut at ('' when unnamed), null for any other cut.
 */
export function oralPart(text: string): { oral: string; cut: boolean; code: string | null } {
  const lines = text.split('\n');
  const cutAt = (i: number, code: string | null = null) => ({ oral: lines.slice(0, i).join('\n').trim(), cut: true, code });
  let listStart = -1;
  let listItems = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s{0,3}(?:```|~~~)\s*([\w+#.-]*)/.exec(line);
    if (fence) return cutAt(i, fence[1] ?? '');
    if (/^\s{0,3}#{1,6}\s/.test(line) || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return cutAt(i);
    if (/^\s*\|.*\|\s*$/.test(line)) return cutAt(i);
    if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) return cutAt(i > 0 && lines[i - 1]!.includes('|') ? i - 1 : i);
    if (/^\s{0,3}(?:[-*+•]|\d+[.)])\s+/.test(line)) {
      if (listItems === 0) listStart = i;
      if (++listItems > 2) return cutAt(listStart);
    } else if (line.trim()) {
      listItems = 0;
    }
  }
  return { oral: text, cut: false, code: null };
}

/** How a code block's language is said: "Код для PowerShell — в чате." */
const CODE_NAMES: Record<string, string> = {
  powershell: 'PowerShell',
  ps1: 'PowerShell',
  pwsh: 'PowerShell',
  bash: 'Bash',
  sh: 'Bash',
  zsh: 'Bash',
  shell: 'Bash',
  console: 'Bash',
  python: 'Python',
  py: 'Python',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TypeScript',
  json: 'JSON',
  sql: 'SQL',
  swift: 'Swift',
  cs: 'C#',
  csharp: 'C#',
};

/** Sentence ends we can read aloud before the rest of the reply has streamed in. */
const SENTENCE_END = /[.!?…]+["»)]?\s+/g;

/** Splits streamed text into the sentences that are complete; the tail stays until more arrives or the reply ends. */
export function completeSentences(text: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let last = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    done.push(text.slice(last, m.index! + m[0].length).trim());
    last = m.index! + m[0].length;
  }
  return { done: done.filter(Boolean), rest: text.slice(last) };
}

/** Lower-case words without punctuation; ё reads as е. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/’/g, "'")
    .split(/[\s.,!?;:…"«»„“”()[\]{}<>/\\|*_~`#+=@%^&$—–-]+/)
    .filter(Boolean);
}

const REGIONS: Record<string, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  uk: 'uk-UA',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  pt: 'pt-BR',
  pl: 'pl-PL',
  tr: 'tr-TR',
  kk: 'kk-KZ',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
};

/** A BCP 47 tag with a region, as speech recognition wants it: ru → ru-RU, en-GB stays, nothing → en-US. */
export function callLanguage(locale: string | undefined): string {
  if (!locale) return 'en-US';
  const [rawLang = '', region] = locale.replace(/_/g, '-').split('-');
  const lang = rawLang.toLowerCase();
  if (lang === 'ru') return 'ru-RU';
  if (region && /^[A-Za-z]{2}$/.test(region)) return `${lang}-${region.toUpperCase()}`;
  return REGIONS[lang] ?? `${lang}-${lang.toUpperCase()}`;
}

/** What tells that the user speaks Russian although the phone may be in English. */
export interface LanguageHints {
  /** What the user typed in the chats lately (recentUserTexts). */
  texts?: readonly string[];
  /** Languages of the phone's keyboards. */
  keyboards?: readonly string[];
}

/**
 * The language picked in Settings. "auto" is Russian when the user writes Russian in the chats, or the phone has a
 * Russian keyboard or Russian among its languages (many Russian speakers keep the iPhone in English); otherwise the
 * phone's first language.
 */
export function resolveCallLanguage(choice: string, preferred: readonly string[], hints: LanguageHints = {}): string {
  if (choice && choice !== 'auto') return choice;
  const russian = [...preferred, ...(hints.keyboards ?? [])].some((l) => callLang(l) === 'ru') || writesRussian(hints.texts ?? []);
  return russian ? 'ru-RU' : callLanguage(preferred[0]);
}

/** Russian makes up a fair share of what the user typed: code, paths and names are Latin even in Russian chats. */
export function writesRussian(texts: readonly string[]): boolean {
  let cyrillic = 0;
  let latin = 0;
  for (const text of texts) {
    cyrillic += text.match(/[а-яё]/gi)?.length ?? 0;
    latin += text.match(/[a-z]/gi)?.length ?? 0;
  }
  return cyrillic >= 12 && cyrillic * 2 >= latin;
}

/** The user's own messages, the last few of each chat. */
export function recentUserTexts(threads: Readonly<Record<string, readonly ChatItem[] | undefined>>, perChat = 10): string[] {
  const texts: string[] = [];
  for (const items of Object.values(threads)) {
    if (!items) continue;
    let taken = 0;
    for (let i = items.length - 1; i >= 0 && taken < perChat; i--) {
      const item = items[i]!;
      if (item.type === 'user' && item.text) {
        texts.push(item.text);
        taken++;
      }
    }
  }
  return texts;
}

export type CallLang = 'ru' | 'en';

export function callLang(language: string): CallLang {
  return language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Words after which people usually go on: a pause there is not the end of the sentence. */
const HOLD_WORDS: Record<CallLang, string[]> = {
  ru: ['и', 'а', 'но', 'или', 'что', 'чтобы', 'потому', 'если', 'когда', 'который', 'которая', 'которые', 'это', 'ну', 'вот', 'типа', 'в', 'на', 'с', 'к', 'по', 'для', 'из', 'за', 'от', 'до', 'о', 'про', 'же', 'еще', 'как', 'где', 'то', 'там'],
  en: ['and', 'but', 'or', 'so', 'because', 'that', 'the', 'a', 'an', 'to', 'of', 'for', 'with', 'if', 'when', 'which', 'um', 'uh', 'like', 'is', 'are', 'my', 'your'],
};

export function holdWords(lang: CallLang): string[] {
  return HOLD_WORDS[lang];
}

/**
 * How long a pause ends an utterance: 0.8 s after a full stop the recognizer punctuated, `silenceMs` (1.1 s) after
 * other words, 0.7 s longer after "и", "что", "ещё" and the like. The native engine applies the same rule
 * (CallEngine.endpointDelay).
 */
export function endpointDelay(text: string, silenceMs: number, hold: readonly string[]): number {
  const trimmed = text.trim();
  let wait = silenceMs;
  if (/[.!?…]$/.test(trimmed)) wait = Math.min(wait, 800);
  const last = words(trimmed).at(-1) ?? '';
  if (hold.includes(last)) wait += 700;
  return wait;
}

const STOP_WORDS = new Set(['стоп', 'хватит', 'подожди', 'погоди', 'стой', 'замолчи', 'тихо', 'stop', 'wait', 'enough', 'quiet']);

/** Only "stop", "wait"…: the user wants silence, not an answer. */
export function isStopRequest(text: string): boolean {
  const said = words(text);
  return said.length > 0 && said.length <= 2 && said.some((w) => STOP_WORDS.has(w));
}

/**
 * Speech heard while the phone talks: the user cutting in, or what is left of the phone's own voice after echo
 * cancellation. A stop word or two words that mostly are not in the sentence being read count as cutting in.
 */
export function isBargeIn(heard: string, speaking: string): boolean {
  const said = words(heard);
  if (said.length === 0) return false;
  if (said.some((w) => STOP_WORDS.has(w))) return true;
  if (said.length < 2) return false;
  const reading = new Set(words(speaking));
  const echoed = said.filter((w) => reading.has(w)).length;
  return echoed / said.length < 0.5;
}

const YES = new Set(['да', 'ага', 'угу', 'давай', 'можно', 'разрешаю', 'разреши', 'конечно', 'хорошо', 'ок', 'окей', 'валяй', 'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'allow', 'go']);
const NO = new Set(['нет', 'неа', 'нельзя', 'запрещаю', 'отмена', 'отмени', 'стоп', 'no', 'nope', 'deny', 'cancel', 'stop']);
const NOT = new Set(['не', "don't", 'dont', 'not']);

/** "Да" / "нет" to a permission question; null when the answer is something else. */
export function parseYesNo(text: string): 'yes' | 'no' | null {
  const said = words(text);
  if (said.some((w, i) => NOT.has(w) && i < said.length - 1)) return 'no';
  const yes = said.some((w) => YES.has(w));
  const no = said.some((w) => NO.has(w));
  if (no && !yes) return 'no';
  if (yes && !no) return 'yes';
  return null;
}

const PHRASES = {
  ru: {
    permission: (what: string) => `Нужно разрешение: ${what}. Разрешить?`,
    yesOrNo: 'Скажите «да» или «нет».',
    allowed: 'Разрешил.',
    denied: 'Отказал.',
    onScreen: 'Ответьте на экране.',
    wait: 'Секунду.',
    rest: 'Остальное — в чате.',
    code: (name: string | null) => (name ? `Код для ${name} — в чате.` : 'Код — в чате.'),
    inChat: 'Ответ — в чате.',
    offline: 'Нет связи с Маком.',
  },
  en: {
    permission: (what: string) => `Claude needs permission: ${what}. Allow it?`,
    yesOrNo: 'Please say yes or no.',
    allowed: 'Allowed.',
    denied: 'Denied.',
    onScreen: 'Please answer on the screen.',
    wait: 'One second.',
    rest: 'The rest is in the chat.',
    code: (name: string | null) => (name ? `The ${name} code is in the chat.` : 'The code is in the chat.'),
    inChat: 'The answer is in the chat.',
    offline: 'The Mac is offline.',
  },
} as const;

/** The question read aloud for a permission prompt: the tool and what it touches, without paths read letter by letter. */
export function permissionQuestion(tool: string, input: unknown, lang: CallLang): string {
  const name = shortToolName(tool).replace(/_/g, ' ');
  const detail = speakable(summarizeTool(input, 70))
    .replace(/[/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return PHRASES[lang].permission(detail ? `${name}, ${detail}` : name);
}

// ---------------------------------------------------------------------------------------------------------------
// The engine interface: native on iOS (modules/pocket-call), expo-speech-recognition + expo-speech elsewhere.

export type CaptureMode = 'off' | 'listen' | 'watch';
export type VoiceQuality = 'default' | 'enhanced' | 'premium';

export type EngineEvent =
  | { type: 'state'; state: 'connecting' | 'active' | 'held' | 'ended'; reason?: string }
  | { type: 'vad'; speaking: boolean }
  | { type: 'capture'; active: boolean }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'recognitionError'; code: string; message: string }
  | { type: 'speechStart'; id: string }
  | { type: 'speechEnd'; id: string; interrupted: boolean }
  | { type: 'speechIdle' }
  | { type: 'muted'; muted: boolean }
  | { type: 'route'; output: string }
  | { type: 'error'; code: string; message: string; fatal: boolean }
  | { type: 'log'; message: string };

export interface EngineStartOptions {
  language: string;
  voice: string | null;
  callerName: string;
  speaker: boolean;
  useCallKit: boolean;
  silenceMs: number;
  holdWords: string[];
  contextualStrings: string[];
}

export interface EngineInfo {
  /** The phone's own voice is removed from the microphone: the user can talk over it. */
  echoCancellation: boolean;
  callKit: boolean;
  voiceName: string | null;
  voiceQuality: VoiceQuality | null;
}

/** Why an engine could not start. A `permission` one is fixed in the phone's settings. */
export class EngineError extends Error {
  constructor(
    readonly code: 'permission' | 'language' | 'audio',
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface SpeechEngine {
  start(options: EngineStartOptions): Promise<EngineInfo>;
  end(): void;
  setMode(mode: CaptureMode): void;
  cancelCapture(): void;
  speak(id: string, text: string): void;
  stopSpeaking(): void;
  setThinking(on: boolean): void;
  setMuted(muted: boolean): void;
  setSpeaker(on: boolean): void;
  subscribe(listener: (event: EngineEvent) => void): () => void;
}

// ---------------------------------------------------------------------------------------------------------------
// The call

export type CallPhase = 'starting' | 'listening' | 'thinking' | 'speaking' | 'confirming' | 'muted' | 'held' | 'ended' | 'error';

export interface CallSnapshot {
  phase: CallPhase;
  /** What the user is saying, or said last. */
  heard: string;
  /** The sentence being read aloud. */
  said: string;
  userSpeaking: boolean;
  error?: string;
  /** The error is fixed in the phone's settings (a permission is off): the call screen offers to open them. */
  errorAction?: 'settings';
  /** Something worth knowing that does not stop the call. */
  notice?: string;
  echoCancellation: boolean;
  callKit: boolean;
  voiceName: string | null;
  voiceQuality: VoiceQuality | null;
  /** speaker, receiver, bluetooth, headphones… */
  route: string;
  /** The call was ended from the lock screen, a headset or by the system. */
  endedRemotely?: boolean;
}

export interface VoiceCallDeps {
  engine: SpeechEngine;
  /** Sends one utterance to the chat; false when not connected. */
  send: (text: string) => boolean;
  respondPermission: (requestId: string, decision: PermissionDecision) => boolean;
  onChange: (snapshot: CallSnapshot) => void;
  /** BCP 47, e.g. ru-RU: recognition, the voice and the phone's own phrases. */
  language: string;
  voice?: string | null;
  callerName: string;
  speaker?: boolean;
  useCallKit?: boolean;
  /** Talking over the phone stops it (needs echo cancellation). */
  bargeIn?: boolean;
  silenceMs?: number;
  /** The chat as it is when the call starts: none of it is read aloud. */
  initialThread: readonly ChatItem[];
}

const SILENCE_MS = 1100;
/** Claude has said nothing this long after the user spoke: "секунду" first, a soft tone after that. */
const THINKING_CUE_AFTER_MS = 4000;
/** Those cues come at most this often. */
const THINKING_CUE_EVERY_MS = 8000;
const OBSERVATION_PAUSE_MS = 500;
const OBSERVATION_SIGNAL_MS = 200;
/** About 40 seconds of speech: a longer spoken answer is cut short with "the rest is in the chat". */
const MAX_SPOKEN_PER_TURN = 550;
const LOG_LINES = 150;

/**
 * A voice call with one chat. Listens, sends what the user said, reads the reply aloud sentence by sentence as it
 * streams, and goes back to listening when Claude's turn is over (not when one text block ends: tools may follow).
 * The user can talk over the reply when the engine cancels echo, answer permission prompts with "да"/"нет", and the
 */
export class VoiceCall {
  private snap: CallSnapshot;
  private lastSent: CallSnapshot | null = null;
  private readonly lang: CallLang;
  private info: EngineInfo | null = null;
  private unsubscribe: (() => void) | null = null;
  private ended = false;
  private failed = false;
  private muted = false;
  private held = false;
  private mode: CaptureMode = 'off';
  private thinkingSound = false;
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private observationTimer: ReturnType<typeof setTimeout> | null = null;
  private observationSignal: { key: string; text: string } | null = null;
  /** A notice about something that passes (recognition trouble, the background): cleared once the user is heard. */
  private passingNotice: string | null = null;
  private lastCueAt = Number.NEGATIVE_INFINITY;
  /** "Секунду" was said in this turn: later cues are the tone. */
  private waitSaid = false;
  // The time to the first sound of the answer: when the user's voice stopped, when the utterance went out, and the
  // sentence whose start ends the wait.
  private voiceEndedAt = Number.NEGATIVE_INFINITY;
  private sentAt = 0;
  private firstSoundPending = false;
  private firstSoundId: string | null = null;

  // The chat
  private items: readonly ChatItem[];
  private sessionState: SessionState | undefined;
  /** Assistant item key → characters of its speakable text already queued. */
  private readonly spoken = new Map<string, number>();
  private readonly observedResults = new Set<string>();
  private readonly queuedObservations: { key: string; text: string }[] = [];
  /** Utterances sent during this call: the last that many user messages of the thread are ours. */
  private sentCount = 0;
  private awaitingReply = false;
  /** After the user cut in: assistant text up to here, and after it until the next user message, is skipped. */
  private skipFrom = -1;
  private spokenThisTurn = 0;
  private turnCapped = false;

  // Speech: sentences handed to the engine and not finished yet
  private seq = 0;
  private readonly pending = new Map<string, string>();
  private readonly started = new Set<string>();
  private current: string | null = null;

  // Permissions
  private readonly asked = new Set<string>();
  private confirming: { requestId: string; retries: number } | null = null;

  private readonly logLines: string[] = [];

  constructor(private readonly deps: VoiceCallDeps) {
    this.lang = callLang(deps.language);
    this.items = deps.initialThread;
    for (const item of this.items) if (item.type === 'result' && item.observation) this.observedResults.add(item.key);
    this.snap = {
      phase: 'starting',
      heard: '',
      said: '',
      userSpeaking: false,
      echoCancellation: false,
      callKit: false,
      voiceName: null,
      voiceQuality: null,
      route: '',
    };
  }

  snapshot(): CallSnapshot {
    return this.snap;
  }

  /** The last lines of what happened, for "send diagnostics". */
  log(): string {
    return this.logLines.join('\n');
  }

  async start(): Promise<void> {
    this.unsubscribe = this.deps.engine.subscribe((e) => this.onEngine(e));
    this.note(`start ${this.deps.language}`);
    try {
      const info = await this.deps.engine.start({
        language: this.deps.language,
        voice: this.deps.voice ?? null,
        callerName: this.deps.callerName,
        speaker: this.deps.speaker !== false,
        useCallKit: this.deps.useCallKit !== false,
        silenceMs: this.deps.silenceMs ?? SILENCE_MS,
        holdWords: holdWords(this.lang),
        contextualStrings: ['Claude', 'скриншот', 'буфер обмена', 'Mac', 'VS Code'],
      });
      if (this.ended) return;
      this.info = info;
      this.note(`engine: echo cancellation ${info.echoCancellation}, CallKit ${info.callKit}, voice ${info.voiceName ?? '-'} (${info.voiceQuality ?? '-'})`);
      this.snap = {
        ...this.snap,
        echoCancellation: info.echoCancellation,
        callKit: info.callKit,
        voiceName: info.voiceName,
        voiceQuality: info.voiceQuality,
        ...(info.voiceQuality === 'default' ? { notice: voiceHint(this.lang) } : {}),
      };
      this.sync();
    } catch (e) {
      if (this.ended) return;
      this.fail(e instanceof Error ? e.message : String(e), e instanceof EngineError && e.code === 'permission' ? 'settings' : undefined);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearThinking();
    this.clearObservationAnnouncements();
    this.deps.engine.end();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.note('end');
    this.emit({ ...this.snap, phase: this.failed ? 'error' : 'ended', userSpeaking: false });
  }

  setMuted(muted: boolean): void {
    if (this.ended) return;
    this.deps.engine.setMuted(muted);
    // The engine confirms with a `muted` event; show the tap at once.
    this.muted = muted;
    this.sync();
  }

  setSpeaker(on: boolean): void {
    if (!this.ended) this.deps.engine.setSpeaker(on);
  }

  /** The user tapped while the phone talks: stop reading this reply and listen. */
  interrupt(): void {
    if (this.ended || !this.speakingNow()) return;
    this.cutIn('');
  }

  /** Every update of this session's thread and state. */
  onThread(items: readonly ChatItem[], sessionState: SessionState | undefined): void {
    if (this.ended) return;
    this.sessionState = sessionState;
    if (items !== this.items) {
      if (this.rebuilt(items)) {
        // History was reloaded with fresh keys: what it holds counts as already read.
        this.note(`thread reloaded (${items.length} items)`);
        for (const item of items) {
          if (item.type === 'assistant') this.spoken.set(item.key, Number.MAX_SAFE_INTEGER);
          if (item.type === 'result' && item.observation) this.observedResults.add(item.key);
        }
        this.skipFrom = -1;
      }
      this.items = items;
      this.read();
    }
    if (this.awaitingReply && this.turnFinished()) {
      this.awaitingReply = false;
      this.note('turn finished');
    }
    this.queueObservationReplies(items);
    this.sync();
    this.drainObservationQueue();
  }

  /** Pending permission prompts of this session. */
  onPermissions(pending: readonly PermissionRequest[]): void {
    if (this.ended) return;
    if (this.confirming && !pending.some((p) => p.requestId === this.confirming!.requestId)) {
      this.note('permission answered elsewhere');
      this.confirming = null;
    }
    const next = pending.find((p) => !this.asked.has(p.requestId));
    if (next && !this.confirming) {
      this.asked.add(next.requestId);
      this.confirming = { requestId: next.requestId, retries: 0 };
      this.note(`permission ${next.tool}`);
      this.say(permissionQuestion(next.tool, next.input, this.lang), true);
    }
    this.sync();
    this.drainObservationQueue();
  }

  // -------------------------------------------------------------------------------------------------------------

  private onEngine(e: EngineEvent): void {
    if (this.ended) return;
    switch (e.type) {
      case 'state':
        if (e.state === 'ended') {
          this.note(`engine ended (${e.reason ?? ''})`);
          this.snap = { ...this.snap, endedRemotely: e.reason !== 'local' };
          this.end();
          return;
        }
        this.held = e.state === 'held';
        break;
      case 'vad':
        this.snap = { ...this.snap, userSpeaking: e.speaking };
        if (!e.speaking) this.voiceEndedAt = Date.now();
        // Echo or noise opened the recognizer while the phone talks and nothing came of it.
        if (!e.speaking && this.mode === 'watch') this.deps.engine.cancelCapture();
        break;
      case 'partial':
        this.onPartial(e.text);
        break;
      case 'final':
        this.onUtterance(e.text);
        break;
      case 'speechStart':
        if (e.id === this.firstSoundId) {
          this.firstSoundId = null;
          this.noteFirstSound();
        }
        this.started.add(e.id);
        this.current = this.pending.get(e.id) ?? null;
        if (this.current !== null) this.snap = { ...this.snap, said: this.current };
        break;
      case 'speechEnd':
        this.pending.delete(e.id);
        this.started.delete(e.id);
        this.current = null;
        break;
      case 'speechIdle':
        // Sentences already started are over; ones not started yet may still be on their way to the engine.
        for (const id of this.started) this.pending.delete(id);
        this.started.clear();
        this.current = null;
        break;
      case 'muted':
        this.muted = e.muted;
        break;
      case 'route':
        this.snap = { ...this.snap, route: e.output };
        break;
      case 'recognitionError': {
        this.note(`recognition error ${e.code}: ${e.message}`);
        const notice = recognitionNotice(e.code, this.deps.language);
        if (notice) this.notice(notice);
        break;
      }
      case 'error':
        this.note(`error ${e.code}: ${e.message}`);
        if (e.fatal) {
          this.fail(e.message);
          return;
        }
        this.notice(e.message);
        break;
      case 'log':
        this.note(e.message);
        break;
      case 'capture':
        break;
    }
    this.sync();
  }

  private speakingNow(): boolean {
    return this.current !== null || this.pending.size > 0;
  }

  private onPartial(text: string): void {
    if (this.speakingNow()) {
      const answering = this.confirming !== null && parseYesNo(text) !== null;
      if (answering || (this.canBargeIn() && isBargeIn(text, this.current ?? ''))) this.cutIn(text);
      return;
    }
    this.snap = { ...this.snap, heard: text };
  }

  private onUtterance(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    if (this.speakingNow()) {
      // Heard while the phone talks: the user cutting in, or what is left of the phone's own voice.
      const answering = this.confirming !== null && parseYesNo(text) !== null;
      if (!answering && !isStopRequest(text) && !(this.canBargeIn() && isBargeIn(text, this.current ?? ''))) {
        this.note(`ignored while speaking: ${text}`);
        return;
      }
      this.cutIn(text);
    }
    this.note(`heard: ${text}`);
    this.snap = { ...this.snap, heard: text };
    if (this.passingNotice !== null && this.snap.notice === this.passingNotice) this.snap = { ...this.snap, notice: undefined };
    this.passingNotice = null;
    if (this.confirming) {
      this.answerPermission(text);
      return;
    }
    if (isStopRequest(text)) return;
    if (!this.deps.send(text)) {
      this.note('send failed: offline');
      this.say(PHRASES[this.lang].offline, true);
      return;
    }
    this.sentCount++;
    this.awaitingReply = true;
    this.spokenThisTurn = 0;
    this.turnCapped = false;
    this.waitSaid = false;
    this.sentAt = Date.now();
    this.firstSoundPending = true;
    this.firstSoundId = null;
  }

  /** How long the user waited: from the end of their phrase to the first sound of the answer. */
  private noteFirstSound(): void {
    const now = Date.now();
    // The pause that ended the utterance comes right before it went out; an older one belongs to another phrase.
    const fromVoice = this.voiceEndedAt <= this.sentAt && this.sentAt - this.voiceEndedAt < 5000 ? `${now - this.voiceEndedAt} ms after the user stopped talking, ` : '';
    this.note(`reply: first sound ${fromVoice}${now - this.sentAt} ms after sending`);
  }

  /** Stops the reply being read; the rest of this turn stays in the chat. */
  private cutIn(text: string): void {
    this.note(`cut in${text ? `: ${text}` : ''}`);
    this.skipFrom = this.items.length - 1;
    // The user moved on: the rest of that turn is not waited for either.
    this.awaitingReply = false;
    this.firstSoundPending = false;
    this.firstSoundId = null;
    this.deps.engine.stopSpeaking();
    this.pending.clear();
    this.started.clear();
    this.current = null;
    this.snap = { ...this.snap, said: '', heard: text || this.snap.heard };
  }

  private answerPermission(text: string): void {
    const pending = this.confirming!;
    const answer = parseYesNo(text);
    const phrases = PHRASES[this.lang];
    if (answer) {
      this.confirming = null;
      this.deps.respondPermission(pending.requestId, answer === 'yes' ? 'allow' : 'deny');
      this.note(`permission ${answer}`);
      this.say(answer === 'yes' ? phrases.allowed : phrases.denied, true);
    } else if (pending.retries < 1) {
      pending.retries++;
      this.say(phrases.yesOrNo, true);
    } else {
      this.confirming = null;
      this.say(phrases.onScreen, true);
    }
  }

  /** Where this call's conversation starts in the thread: at the first of our messages that came back. */
  private convoStart(): number {
    if (this.sentCount === 0) return this.items.length;
    let need = this.sentCount;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]!.type === 'user' && --need === 0) return i;
    }
    return this.items.length;
  }

  /** Queues what is new in the assistant's text. */
  private read(): void {
    let userAfterSkip = false;
    for (let i = this.convoStart(); i < this.items.length; i++) {
      const item = this.items[i]!;
      if (item.type === 'user' && i > this.skipFrom) userAfterSkip = true;
      if (item.type !== 'assistant') continue;
      if (this.skipFrom >= 0 && (i <= this.skipFrom || !userAfterSkip)) {
        this.spoken.set(item.key, Number.MAX_SAFE_INTEGER);
        continue;
      }
      this.readItem(item);
    }
  }

  private readItem(item: Extract<ChatItem, { type: 'assistant' }>): void {
    if (item.observation) {
      this.spoken.set(item.key, Number.MAX_SAFE_INTEGER);
      return;
    }
    const part = oralPart(item.text);
    const clean = speakable(part.oral);
    const done = this.spoken.get(item.key) ?? 0;
    // Past a code block or a table the spoken part is complete, even while the rest still streams in.
    const complete = !item.streaming || part.cut;
    if (done < clean.length) {
      const pending = clean.slice(done);
      const { done: full, rest } = completeSentences(pending);
      const fresh = complete ? [...full, rest.trim()].filter(Boolean) : full;
      this.spoken.set(item.key, complete ? clean.length : done + pending.length - rest.length);
      for (const sentence of fresh) this.say(sentence, false);
    }
    if (!part.cut || done === Number.MAX_SAFE_INTEGER) return;
    this.spoken.set(item.key, Number.MAX_SAFE_INTEGER);
    if (this.turnCapped) return;
    // Nothing more of this turn is read: the details are in the chat.
    const phrases = PHRASES[this.lang];
    const phrase = this.spokenThisTurn > 0 ? phrases.rest : part.code !== null ? phrases.code(CODE_NAMES[part.code.toLowerCase()] ?? null) : phrases.inChat;
    this.turnCapped = true;
    this.say(phrase, true);
  }

  private queueObservationReplies(items: readonly ChatItem[]): void {
    for (let i = 0; i < items.length; i++) {
      const result = items[i]!;
      if (result.type !== 'result' || !result.observation || this.observedResults.has(result.key)) continue;
      this.observedResults.add(result.key);

      let answer = '';
      for (let j = i - 1; j >= 0; j--) {
        const item = items[j]!;
        if (item.type === 'user') break;
        if (item.type === 'assistant' && item.observation) {
          answer = item.text;
          break;
        }
      }
      const raw = answer.trim();
      if (!raw || raw.toLowerCase() === '[quiet]') continue;
      const text = speakable(oralPart(raw).oral);
      if (text) this.queuedObservations.push({ key: result.key, text });
    }
  }

  private observationCanSpeak(): boolean {
    return !this.ended && !this.failed && !this.held && !this.snap.userSpeaking && !this.speakingNow() && !this.awaitingReply && this.sessionState !== 'running' && this.sessionState !== 'waiting_permission';
  }

  private drainObservationQueue(): void {
    if (!this.observationCanSpeak()) {
      this.cancelObservationAnnouncement();
      return;
    }
    if (!this.queuedObservations.length || this.observationTimer) return;
    this.observationTimer = setTimeout(() => {
      this.observationTimer = null;
      if (!this.observationCanSpeak()) return;
      const next = this.queuedObservations.shift();
      if (!next) return;
      this.observationSignal = next;
      this.deps.engine.setThinking(true);
      this.observationTimer = setTimeout(() => {
        this.observationTimer = null;
        this.deps.engine.setThinking(false);
        this.observationSignal = null;
        if (!this.observationCanSpeak()) {
          this.queuedObservations.unshift(next);
          return;
        }
        this.note(`screen observation ${next.key}`);
        this.say(next.text, true);
        this.sync();
        this.drainObservationQueue();
      }, OBSERVATION_SIGNAL_MS);
    }, OBSERVATION_PAUSE_MS);
  }

  private cancelObservationAnnouncement(): void {
    if (this.observationTimer) clearTimeout(this.observationTimer);
    this.observationTimer = null;
    if (this.observationSignal) {
      this.deps.engine.setThinking(false);
      this.queuedObservations.unshift(this.observationSignal);
      this.observationSignal = null;
    }
  }

  private clearObservationAnnouncements(): void {
    if (this.observationTimer) clearTimeout(this.observationTimer);
    this.observationTimer = null;
    if (this.observationSignal) this.deps.engine.setThinking(false);
    this.observationSignal = null;
    this.queuedObservations.length = 0;
  }

  private say(text: string, always: boolean, filler = false): void {
    let sentence = text;
    if (!always) {
      if (this.turnCapped) return;
      if (this.spokenThisTurn + sentence.length > MAX_SPOKEN_PER_TURN) {
        this.turnCapped = true;
        sentence = PHRASES[this.lang].rest;
      }
      this.spokenThisTurn += sentence.length;
    }
    const id = `s${++this.seq}`;
    if (this.firstSoundPending && !filler) {
      this.firstSoundPending = false;
      this.firstSoundId = id;
    }
    this.pending.set(id, sentence);
    this.deps.engine.speak(id, sentence);
  }

  /** Claude's turn after our last message is over: a result or an error follows it, or the session went idle. */
  private turnFinished(): boolean {
    const start = this.convoStart();
    if (start >= this.items.length) return false;
    for (let i = this.items.length - 1; i >= start; i--) {
      const type = this.items[i]!.type;
      if (type === 'result' || type === 'error') return true;
      if (type === 'user') break;
    }
    const last = this.items[this.items.length - 1]!;
    return this.sessionState === 'idle' && last.type !== 'user' && !(last.type === 'assistant' && last.streaming);
  }

  /** The thread was replaced (history loaded again) rather than appended to. */
  private rebuilt(items: readonly ChatItem[]): boolean {
    const prev = this.items;
    if (prev.length === 0) return false;
    return items.length < prev.length || items[0]?.key !== prev[0]?.key;
  }

  private canBargeIn(): boolean {
    return this.info?.echoCancellation === true && this.deps.bargeIn !== false;
  }

  private phase(): CallPhase {
    if (this.failed) return 'error';
    if (this.ended) return 'ended';
    if (!this.info) return 'starting';
    if (this.held) return 'held';
    if (this.muted) return 'muted';
    if (this.speakingNow()) return 'speaking';
    if (this.confirming) return 'confirming';
    if (this.awaitingReply) return 'thinking';
    return 'listening';
  }

  private sync(): void {
    if (this.ended) return;
    const phase = this.phase();
    let mode: CaptureMode = 'listen';
    if (!this.info || this.held || this.muted) mode = 'off';
    else if (phase === 'speaking') mode = this.canBargeIn() ? 'watch' : 'off';
    if (mode !== this.mode) {
      this.mode = mode;
      this.deps.engine.setMode(mode);
    }
    if (phase === 'thinking') {
      if (!this.thinkingSound && !this.thinkingTimer) {
        const wait = Math.max(THINKING_CUE_AFTER_MS, this.lastCueAt + THINKING_CUE_EVERY_MS - Date.now());
        this.thinkingTimer = setTimeout(() => this.cue(), wait);
      }
    } else {
      this.clearThinking();
    }
    this.emit({ ...this.snap, phase });
  }

  /** Claude is still quiet: say "секунду" once a turn (no tone on Android), then the engine's soft tone. */
  private cue(): void {
    this.thinkingTimer = null;
    if (this.ended || this.phase() !== 'thinking') return;
    this.lastCueAt = Date.now();
    if (!this.waitSaid) {
      this.waitSaid = true;
      this.note('still thinking: said "one second"');
      this.say(PHRASES[this.lang].wait, true, true);
      this.sync();
      return;
    }
    this.thinkingSound = true;
    this.deps.engine.setThinking(true);
  }

  private clearThinking(): void {
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = null;
    if (this.thinkingSound) {
      this.thinkingSound = false;
      this.deps.engine.setThinking(false);
    }
  }

  private fail(message: string, action?: 'settings'): void {
    this.note(`failed: ${message}`);
    this.failed = true;
    this.snap = { ...this.snap, error: message, ...(action ? { errorAction: action } : {}) };
    this.end();
  }

  private notice(text: string): void {
    this.passingNotice = text;
    this.snap = { ...this.snap, notice: text };
  }

  private emit(next: CallSnapshot): void {
    this.snap = next;
    const prev = this.lastSent;
    if (prev && SNAPSHOT_KEYS.every((key) => prev[key] === next[key])) return;
    this.lastSent = next;
    this.deps.onChange(next);
  }

  private note(line: string): void {
    this.logLines.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    if (this.logLines.length > LOG_LINES) this.logLines.shift();
  }
}

/**
 * A call update worth a re-render while the app is in the background (screen locked, another app in front): a new
 * phase or an error. What was heard and said waits until the app is back; nobody can see it meanwhile.
 */
export function showsInBackground(shown: CallSnapshot | null, next: CallSnapshot): boolean {
  return shown === null || shown.phase !== next.phase || shown.error !== next.error;
}

const SNAPSHOT_KEYS: (keyof CallSnapshot)[] = [
  'phase',
  'heard',
  'said',
  'userSpeaking',
  'error',
  'errorAction',
  'notice',
  'echoCancellation',
  'callKit',
  'voiceName',
  'voiceQuality',
  'route',
  'endedRemotely',
];

/** Recognition trouble the user can do something about, in words; null for what only goes to the log. */
function recognitionNotice(code: string, language: string): string | null {
  if (code === 'unavailable' || code === 'network') return 'Speech recognition is unavailable right now: check the internet connection.';
  if (code === 'language-not-supported') return `Speech recognition does not support ${language} on this phone. Pick another language in Pocket settings.`;
  return null;
}

function voiceHint(lang: CallLang): string {
  return lang === 'ru'
    ? 'A better Russian voice: iPhone Settings → Accessibility → Read & Speak (Spoken Content before iOS 26) → Voices → Russian → Milena (Enhanced), then pick it in Pocket settings.'
    : 'A better voice: iPhone Settings → Accessibility → Read & Speak (Spoken Content before iOS 26) → Voices, download an Enhanced or Premium voice, then pick it in Pocket settings.';
}
