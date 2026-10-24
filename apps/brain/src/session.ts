import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { realpathSync } from 'node:fs';
import {
  type BackgroundTask,
  type Effort,
  type ModelInfo,
  type RunningTool,
  MCP_SERVER_NAME,
  type SessionEvent,
  type SessionMeta,
  type SessionState,
  type Subagent,
} from '@pocket/protocol';
import { CHAT_ALLOWED_TOOLS, chatTools, chatToolsPrompt, FALLBACK_MODELS, type ChatControl } from './chat-tools.js';
import { computerTools, computerToolsPrompt, ComputerState } from './computer-tools.js';
import { agentDefinitions, AUTO_ALLOWED_TOOLS, BUILTIN_TOOLS, CLAUDE_TOOLS, claudeTool, readLocalSkillFile, toDisplayCall, TOOL_ALIASES } from './claude-tools.js';
import type { ExecutorHandle } from './executor.js';
import { log } from './log.js';
import { PC_ALLOWED_TOOLS, pcTools, pcToolsPrompt, type PcHandle } from './pc-tools.js';
import { ATTACHMENTS_DIR, chatFolder, DEFAULT_MAC_WORKSPACE, macSandbox, macWorkspaceFor, ownFolderPrompt, SANDBOX_PROMPT } from './sandbox.js';
import { ensureSkillsPlugin, paths } from './store.js';
import { applyWatchCompaction, createWatchFrameRef, prepareWatchCompaction, WatchHistory } from './watch-history.js';

export interface SessionHost {
  executorFor(sessionId: string): ExecutorHandle;
  /** The person's PocketClipboard computer for the pc_* tools. */
  pcFor(sessionId: string): PcHandle;
  /** True for chats that run on the Mac without any file or shell access: people who are not the owner and have no tools computer. */
  chatOnly(sessionId: string): boolean;
  userName(sessionId: string): string;
  emit(sessionId: string, event: SessionEvent, durable: boolean): void;
  metaChanged(meta: SessionMeta): void;
  canUseTool: (sessionId: string, toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<PermissionResult>;
  claudeOptions(): Partial<Options>;
  onClaudeVersion(version: string): void;
}

/** A unit of text the user typed plus optional photos and files. */
export interface UserTurn {
  text: string;
  attachments?: { mime: string; dataBase64: string; name?: string }[];
  from: string;
  /** Spoken on a call: the reply is read aloud, so it must be short and plain. */
  voice?: boolean;
  screenFrame?: {
    image: { mime: 'image/jpeg'; dataBase64: string; width: number; height: number };
    windowTitle: string;
    capturedAt: number;
    frameId: string;
    retainFrames: number;
  };
  observation?: { windowTitle: string; capturedAt: number; goal?: string };
}

/** Prepended to spoken turns. Claude keeps its tools; only the shape of the answer changes. */
export const VOICE_NOTE = [
  '[Voice call. The user said this aloud and will hear your reply read by text-to-speech.',
  'Start with the spoken answer: one to three short sentences in the user\'s language, the way a person would say it on the phone, with no markdown, lists, code, commands, paths, links or tables.',
  'Only that part is read aloud. If details help (code, commands, tables, steps), put them after a line with only --- on it: the phone stops reading there and they stay in the chat. Then say so in the spoken part, for example that the code is in the chat.',
  'If they ask for a command, code or any text to paste, put the exact text on their computer with pc_clipboard_write and say it is on the clipboard, ready for Ctrl+V.',
  'If they ask to look at the screen, take a screenshot with pc_screenshot and tell them what matters. If they ask what they copied, read it with pc_clipboard_read and summarise it.',
  'If they ask to switch the model or how hard you think, do it with chat_configure and say in one sentence what changed.',
  'If they ask you to do something on their computer (open a program or a site, type into a window, click something), do it with the computer tool and say in a few words what you are doing.',
  'Before a tool that takes a while, say one short sentence about what you are doing, so the line is not silent.',
  'Do not read out file paths, URLs, hashes or long numbers: describe them in words.',
  'After any action, say in one sentence what you did and what you saw.]',
].join(' ');

export { DEFAULT_MAC_WORKSPACE };

const INLINE_TEXT_LIMIT = 200_000;
const isImage = (mime: string) => /^image\/(png|jpe?g|gif|webp)$/i.test(mime);
const isTextLike = (mime: string, name = '') => /^text\/|json|xml|yaml|javascript|typescript|csv|markdown/i.test(mime) || /\.(txt|md|json|ya?ml|csv|log|ts|tsx|js|jsx|py|cs|java|go|rs|html?|css|sql|sh|ps1|ini|toml|xml)$/i.test(name);

function safeFileName(name: string | undefined, fallback: string): string {
  const cleaned = basename(name ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 120) : fallback;
}

function macSystemPrompt(cwd: string, projectInstructions: string | null, pcName: string | undefined, place: { own: boolean; sandboxed: boolean }): string {
  return [
    '# Workspace',
    `You work on the user\'s Mac in ${cwd}. Use your normal tools there.`,
    'The user chats from a phone. Keep replies short and lead with the outcome; they can copy any reply or code block to their Windows laptop clipboard with one tap, so put things meant for pasting into a single code block.',
    'Files the user attaches (often straight from their Windows clipboard) are saved on this Mac; their paths are listed in the message. Read them from there.',
    place.own ? ownFolderPrompt(cwd) : '',
    place.sandboxed ? SANDBOX_PROMPT : '',
    pcToolsPrompt(pcName),
    computerToolsPrompt(pcName),
    chatToolsPrompt(),
    projectInstructions ? `# Project instructions (CLAUDE.md)\n${projectInstructions}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function chatSystemPrompt(userName: string, pcName: string | undefined): string {
  return [
    '# Chat without a workspace',
    `You are talking to ${userName} from their phone or Telegram. There is no project here and you have no file or shell access anywhere: never try to read, write or run anything. Your working directory is an empty scratch folder; ignore it.`,
    'Answer questions, write code and commands in the chat. Anything meant for pasting goes in one code block, because the user copies a block with one tap. Keep replies short and lead with the outcome, in the user\'s language.',
    pcToolsPrompt(pcName),
    computerToolsPrompt(pcName),
    chatToolsPrompt(),
  ].join('\n\n');
}

/** Built-ins that need a terminal UI or act outside the chat. */
const MAC_DISALLOWED = ['AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification', 'SendUserFile', 'Workflow'];
const MAC_AUTO_ALLOWED = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', ...BUILTIN_TOOLS.filter((t) => t !== 'ExitPlanMode'), ...PC_ALLOWED_TOOLS, ...CHAT_ALLOWED_TOOLS];
const CHAT_BUILTIN_TOOLS = ['WebFetch', 'WebSearch'];

const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const IDLE_SHUTDOWN_MS = 30 * 60_000;

function remoteWorkspaceBlock(workspaces: string[]): string {
  const roots = workspaces.length ? workspaces.map((w) => `- ${w}`).join('\n') : '- (no folder open yet)';
  return [
    '# Remote Windows workspace',
    'All work happens on the user\'s Windows laptop through the mcp__pocket__* tools (Bash, Read, Write, Edit, Glob, Grep, LS, BashOutput, KillShell).',
    'The working directory in your environment details is an empty scratch folder on another machine. Never pass it or any path under it to a tool.',
    `Workspace roots on Windows:\n${roots}`,
    'Paths may be relative to the first root. Bash runs Windows PowerShell: use PowerShell syntax and Windows paths.',
  ].join('\n');
}

function systemPromptFor(workspaces: string[], projectInstructions: string | null, pcName: string | undefined): string {
  const roots = workspaces.length ? workspaces.map((w) => `- ${w}`).join('\n') : '- (no folder open yet)';
  return [
    '# Remote Windows workspace',
    'You run on a separate machine. All work happens on the user\'s Windows laptop through the mcp__pocket__* tools (Bash, Read, Write, Edit, Glob, Grep, LS, BashOutput, KillShell, git_*). Subagents you start get the same tools.',
    'Nothing on the machine you run on is part of the task: every path and command refers to the Windows laptop. The only exception is skill files, which Read serves locally.',
    'The working directory in your environment details is an empty local scratch folder. Never pass it to a tool.',
    `Workspace roots on Windows:\n${roots}`,
    'Tool paths may be relative; they resolve against the first workspace root. Prefer relative paths.',
    'Bash runs Windows PowerShell, not a POSIX shell: use PowerShell syntax and Windows paths. Use run_in_background for servers and watchers. Read a file before editing it.',
    'The user is chatting from a phone or a small VS Code panel: keep replies short and lead with the outcome.',
    pcToolsPrompt(pcName),
    computerToolsPrompt(pcName),
    chatToolsPrompt(),
    projectInstructions ? `# Project instructions (CLAUDE.md on the Windows workspace)\n${projectInstructions}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Async queue feeding user turns into the long-lived Claude Code query. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;

  get hasPending(): boolean {
    return this.items.length > 0;
  }

  push(msg: SDKUserMessage): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else this.items.push(msg);
  }

  end(): void {
    this.done = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

/**
 * One chat thread backed by one Claude Code session.
 * The Claude Code process is started lazily and stopped after a period of inactivity; it is resumed by id later.
 */
export class Session {
  private q: Query | null = null;
  private pumpPromise: Promise<void> | null = null;
  private input: InputQueue | null = null;
  private abort: AbortController | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingToolUseIds = new Map<string, string[]>();
  private readonly running = new Map<string, RunningTool>();
  private readonly background = new Map<string, BackgroundTask>();
  private readonly agents = new Map<string, Subagent>();
  private turnStartedAt: number | undefined;
  /** Computer the running Claude Code process was started for; its prompt names that computer's folders. */
  private startedOn: string | undefined;
  private restartAfterTurn = false;
  /** Model/effort Claude switched to from inside a turn; the live process takes it when the turn ends. */
  private pendingConfig: { model?: string | null; effort?: Effort | null } | null = null;
  /** Which screenshot Claude's computer-use coordinates refer to. */
  private readonly computer = new ComputerState();
  /** Deleted chats must not resurface through late state updates from a stopping process. */
  private destroyed = false;
  private streamedText = false;
  private textBuffer = '';
  private started: boolean;
  private sendTail: Promise<void> = Promise.resolve();
  private readonly watchHistory: WatchHistory;

  constructor(
    public meta: SessionMeta,
    private readonly host: SessionHost,
    resumable: boolean,
  ) {
    this.started = resumable;
    this.watchHistory = new WatchHistory(join(paths.sessionsDir, meta.sessionId + '.watch-history.json'));
  }

  get id(): string {
    return this.meta.sessionId;
  }

  get live(): boolean {
    return this.q !== null;
  }

  runningTools(): RunningTool[] {
    return [...this.running.values()];
  }

  /** Background commands or subagents are still working even if the turn has ended. */
  get busy(): boolean {
    return this.running.size > 0 || this.background.size > 0 || this.agents.size > 0;
  }

  subagents(): Subagent[] {
    return [...this.agents.values()];
  }

  backgroundTasks(): BackgroundTask[] {
    return [...this.background.values()];
  }

  get turnStarted(): number | undefined {
    return this.turnStartedAt;
  }

  /** Applies model/effort to the live Claude Code process too, without restarting it. */
  async configure(patch: { model?: string | null; effort?: Effort | null }): Promise<void> {
    const next: Partial<SessionMeta> = {};
    if (patch.model !== undefined) next.model = patch.model ?? undefined;
    if (patch.effort !== undefined) next.effort = patch.effort ?? undefined;
    this.setMeta(next);
    if (!this.q) return;
    try {
      if (patch.model !== undefined) await this.q.setModel(patch.model ?? undefined);
      if (patch.effort !== undefined) await this.q.applyFlagSettings({ effortLevel: patch.effort ?? undefined });
    } catch (e) {
      log(`live configure failed for ${this.id}, restarting on next message: ${String(e)}`);
      this.stop();
    }
  }

  /**
   * A change Claude asked for itself (chat_configure). The chat shows it at once; the live process takes it when the
   * turn is over, so the model never changes halfway through a tool loop.
   */
  configureAfterTurn(patch: { model?: string | null; effort?: Effort | null }): void {
    const next: Partial<SessionMeta> = {};
    if (patch.model !== undefined) next.model = patch.model ?? undefined;
    if (patch.effort !== undefined) next.effort = patch.effort ?? undefined;
    this.setMeta(next);
    if (!this.q) return;
    this.pendingConfig = { ...this.pendingConfig, ...patch };
    if (this.meta.state === 'idle' && this.running.size === 0) this.applyPendingConfig();
  }

  private applyPendingConfig(): void {
    const patch = this.pendingConfig;
    this.pendingConfig = null;
    if (patch) void this.configure(patch);
  }

  /** Moves the chat to another computer. The process restarts so Claude sees that computer's folders and CLAUDE.md. */
  /** `executorId` undefined means the Mac itself. */
  setExecutor(executorId: string | undefined, project?: string | null): void {
    if (project === undefined && executorId !== this.meta.executorId && this.meta.project) project = null;
    const projectChanged = project !== undefined && (project ?? undefined) !== this.meta.project;
    this.setMeta({ executorId, ...(project !== undefined ? { project: project ?? undefined } : {}) });
    this.computer.reset();
    if (!this.q || (this.startedOn === executorId && !projectChanged)) return;
    if (this.meta.state === 'idle' && !this.busy) this.stop();
    else this.restartAfterTurn = true;
  }

  setHidden(hidden: boolean): void {
    this.setMeta({ hidden: hidden || undefined });
  }

  /** Stops Claude Code and removes the chat's history from disk. Its own folder on the Mac stays, just in case. */
  destroy(): void {
    this.stop();
    this.destroyed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    rmSync(this.historyFile(), { force: true });
    this.watchHistory.destroy();
    const folder = chatFolder(this.meta);
    if (existsSync(folder)) log(`chat ${this.id} deleted; its files stay in ${folder}`);
  }

  rename(title: string): void {
    this.setMeta({ title });
  }

  async supportedModels(): Promise<ModelInfo[] | null> {
    if (!this.q) return null;
    const models = await this.q.supportedModels();
    return models.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
      ...(m.supportedEffortLevels ? { efforts: m.supportedEffortLevels } : {}),
    }));
  }

  history(): SessionEvent[] {
    try {
      return readFileSync(this.historyFile(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SessionEvent);
    } catch {
      return [];
    }
  }

  async send(turn: UserTurn): Promise<void> {
    const previous = this.sendTail;
    let release!: () => void;
    this.sendTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.sendTurn(turn);
    } finally {
      release();
    }
  }

  private async sendTurn(turn: UserTurn): Promise<void> {
    const attachments = turn.attachments ?? [];
    const images = attachments.filter((a) => isImage(a.mime) && !a.name);
    const files = attachments.filter((a) => !images.includes(a));
    const imageCount = images.length + (turn.screenFrame ? 1 : 0);
    this.record(
      {
        kind: 'user',
        text: turn.text,
        from: turn.from,
        ...(imageCount ? { images: imageCount } : {}),
        ...(files.length ? { files: files.map((f, i) => safeFileName(f.name, `file-${i + 1}`)) } : {}),
        ...(turn.voice ? { voice: true } : {}),
        ...(turn.observation ? { observation: true } : {}),
      },
      true,
    );
    if (!turn.observation) this.setMeta({ lastText: turn.text.slice(0, 200) });
    if (!this.q) await this.start();
    if (turn.screenFrame) await this.trimWatchHistory(Math.max(0, turn.screenFrame.retainFrames - 1));
    this.setState('running');
    this.turnStartedAt ??= Date.now();
    const frameUuid = turn.screenFrame ? randomUUID() : undefined;
    const blocks: Exclude<SDKUserMessage['message']['content'], string> = images.map((img) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: img.mime as 'image/png', data: img.dataBase64 },
    }));
    if (turn.screenFrame) {
      blocks.unshift({
        type: 'image',
        source: {
          type: 'base64',
          media_type: turn.screenFrame.image.mime,
          data: turn.screenFrame.image.dataBase64,
        },
      });
    }
    const notes = this.saveFiles(files, blocks);
    const spoken = turn.voice ? `${VOICE_NOTE}\n\n${turn.text}` : turn.text;
    const text = notes.length ? `${spoken}\n\n${notes.join('\n')}` : spoken;
    const content: SDKUserMessage['message']['content'] = blocks.length ? [...blocks, { type: 'text' as const, text }] : text;
    const origin = turn.observation ? { kind: 'channel' as const, server: 'pocket-screen-watch' } : { kind: 'human' as const };
    this.input!.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin } as SDKUserMessage);
    this.touch();
  }

  /**
   * On the Mac, files land in the chat's inbox and Claude gets their paths. On a remote computer Claude
   * cannot read Mac paths, so text files are inlined instead.
   */
  private saveFiles(files: { mime: string; dataBase64: string; name?: string }[], blocks: Exclude<SDKUserMessage['message']['content'], string>): string[] {
    if (!files.length) return [];
    const onMac = this.host.executorFor(this.id).id === undefined && !this.host.chatOnly(this.id);
    const place = onMac ? macWorkspaceFor(this.meta) : undefined;
    const inbox = place?.own ? join(place.cwd, ATTACHMENTS_DIR) : join(paths.home, 'inbox', this.id);
    if (onMac) mkdirSync(inbox, { recursive: true, mode: 0o700 });
    const notes: string[] = [];
    files.forEach((f, i) => {
      const name = safeFileName(f.name, `file-${i + 1}`);
      const data = Buffer.from(f.dataBase64, 'base64');
      if (onMac) {
        let target = join(inbox, name);
        for (let n = 2; existsSync(target); n++) target = join(inbox, name.replace(/(\.[^.]*)?$/, `-${n}$1`));
        writeFileSync(target, data, { mode: 0o600 });
        notes.push(`[Attached file: ${target}]`);
        if (isImage(f.mime)) blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mime as 'image/png', data: f.dataBase64 } });
      } else if (isTextLike(f.mime, name) && data.length <= INLINE_TEXT_LIMIT) {
        notes.push(`[Attached file ${name}]\n\`\`\`\n${data.toString('utf8')}\n\`\`\``);
      } else if (isImage(f.mime)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mime as 'image/png', data: f.dataBase64 } });
        notes.push(`[Attached image ${name}]`);
      } else {
        notes.push(`[Attached file ${name} (${f.mime}, ${data.length} bytes) could not be passed on: this chat works on another computer]`);
      }
    });
    return notes;
  }

  async interrupt(): Promise<void> {
    // Stop also means hands off the computer: a long text being typed stops and held keys are let go.
    if (this.computer.busy > 0) void this.host.pcFor(this.id).computer({ action: 'release' }).catch(() => {});
    if (!this.q) return;
    try {
      await this.q.interrupt();
    } catch (e) {
      log(`interrupt failed for ${this.id}: ${String(e)}`);
    }
  }

  stop(): void {
    this.restartAfterTurn = false;
    this.pendingConfig = null;
    this.agents.clear();
    this.input?.end();
    this.abort?.abort();
    this.q = null;
    this.input = null;
    this.abort = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.running.clear();
    this.turnStartedAt = undefined;
    if (this.meta.state !== 'idle') this.setState('idle');
  }

  setState(state: SessionState): void {
    if (this.destroyed || this.meta.state === state) return;
    this.setMeta({ state });
    this.host.emit(this.id, { kind: 'state', state }, true);
  }

  private setMeta(patch: Partial<SessionMeta>): void {
    if (this.destroyed) return;
    this.meta = { ...this.meta, ...patch, updatedAt: Date.now() };
    this.host.metaChanged(this.meta);
  }

  private historyFile(): string {
    return join(paths.sessionsDir, `${this.id}.jsonl`);
  }

  private record(event: SessionEvent, durable: boolean): void {
    if (this.destroyed) return;
    if (durable && event.kind !== 'text_delta' && event.kind !== 'tool_output') {
      appendFileSync(this.historyFile(), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    this.host.emit(this.id, event, durable);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.meta.state === 'idle' && !this.busy) {
        log(`session ${this.id} idle, stopping Claude Code`);
        this.stop();
      } else this.touch();
    }, IDLE_SHUTDOWN_MS);
  }

  private async start(): Promise<void> {
    const executor = this.host.executorFor(this.id);
    this.startedOn = executor.id;
    const skillsPlugin = ensureSkillsPlugin();
    const common: Partial<Options> = {
      ...this.host.claudeOptions(),
      ...(this.meta.model ? { model: this.meta.model } : {}),
      ...(this.meta.effort ? { effort: this.meta.effort } : {}),
      settingSources: [],
      ...(skillsPlugin ? { plugins: [{ type: 'local' as const, path: skillsPlugin }], skills: 'all' as const } : {}),
      permissionMode: 'default',
      includePartialMessages: true,
      stderr: (data: string) => log(`claude[${this.id.slice(0, 8)}] ${data.trimEnd()}`),
    };

    let cwd: string;
    let specific: Partial<Options>;
    const pcName = this.host.pcFor(this.id).name;
    if (executor.id === undefined && this.host.chatOnly(this.id)) {
      // No files anywhere: Claude talks, searches the web and reaches the person's own PocketClipboard computer.
      cwd = join(paths.workDir, this.id);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      specific = {
        tools: CHAT_BUILTIN_TOOLS,
        mcpServers: { [MCP_SERVER_NAME]: this.pcServer() },
        strictMcpConfig: true,
        allowedTools: [...CHAT_BUILTIN_TOOLS, ...PC_ALLOWED_TOOLS, ...CHAT_ALLOWED_TOOLS],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: chatSystemPrompt(this.host.userName(this.id), pcName) },
      };
    } else if (executor.id === undefined) {
      const place = macWorkspaceFor(this.meta);
      cwd = place.cwd;
      mkdirSync(cwd, { recursive: true });
      const sandbox = macSandbox(process.env, { autoAllow: place.own });
      specific = {
        tools: { type: 'preset', preset: 'claude_code' },
        disallowedTools: MAC_DISALLOWED,
        allowedTools: MAC_AUTO_ALLOWED,
        mcpServers: { [MCP_SERVER_NAME]: this.pcServer() },
        ...(sandbox ? { sandbox } : {}),
        // The chat's own folder is its sandbox: edits and commands there go through; a picked project still asks.
        ...(place.own ? { permissionMode: 'acceptEdits' as const } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: macSystemPrompt(cwd, readInstructions(cwd), pcName, { own: place.own, sandboxed: !!sandbox }) },
      };
    } else {
      const roots = executor.root ? [executor.root] : (executor.info?.workspaces ?? []);
      let projectInstructions: string | null = null;
      if (executor.online) {
        const r = await executor.call('read_file', { path: 'CLAUDE.md' }, { timeoutMs: 15_000 });
        if (!r.isError) projectInstructions = r.content.replace(/^\s*\d+\t/gm, '');
      }
      cwd = join(paths.workDir, this.id);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      specific = {
        tools: [...BUILTIN_TOOLS],
        toolAliases: TOOL_ALIASES,
        mcpServers: { [MCP_SERVER_NAME]: this.mcpServer() },
        strictMcpConfig: true,
        allowedTools: [...AUTO_ALLOWED_TOOLS, ...PC_ALLOWED_TOOLS, ...CHAT_ALLOWED_TOOLS],
        agents: agentDefinitions(remoteWorkspaceBlock(roots)),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptFor(roots, projectInstructions, pcName) },
      };
    }

    const previous = this.meta.engine ?? (this.started ? { id: this.id, cwd: join(paths.workDir, this.id) } : undefined);
    const resume = previous !== undefined && previous.cwd === cwd;
    const engineId = resume ? previous.id : randomUUID();
    this.setMeta({ engine: { id: engineId, cwd } });

    this.input = new InputQueue();
    this.abort = new AbortController();
    const canUseTool: CanUseTool = (toolName, input, { signal }) => this.host.canUseTool(this.id, toolName, input, signal);
    const options: Options = {
      ...common,
      ...specific,
      cwd,
      canUseTool,
      abortController: this.abort,
      ...(resume ? { resume: engineId } : { sessionId: engineId }),
    };
    this.started = true;
    this.q = query({ prompt: this.input, options });
    void this.pump(this.q);
  }

  /** The pc_* and chat_* tools: what Mac and chat-only sessions get. */
  private pcServer() {
    return createSdkMcpServer({ name: MCP_SERVER_NAME, version: '0.1.0', alwaysLoad: true, tools: [...pcTools(() => this.host.pcFor(this.id)), ...computerTools(() => this.host.pcFor(this.id), this.computer), ...chatTools(() => this.chatControl())] });
  }

  private chatControl(): ChatControl {
    return {
      current: () => ({ ...(this.meta.model ? { model: this.meta.model } : {}), ...(this.meta.effort ? { effort: this.meta.effort } : {}) }),
      models: async () => {
        const live = await this.supportedModels().catch(() => null);
        return live?.length ? live : FALLBACK_MODELS;
      },
      configure: (patch) => this.configureAfterTurn(patch),
    };
  }

  private mcpServer() {
    const executor = this.host.executorFor(this.id);
    const skillDirs = skillDirectories();
    const scratch = scratchPrefixes(join(paths.workDir, this.id));
    return createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: '0.1.0',
      alwaysLoad: true,
      tools: [...pcTools(() => this.host.pcFor(this.id)), ...computerTools(() => this.host.pcFor(this.id), this.computer), ...chatTools(() => this.chatControl()), ...CLAUDE_TOOLS.map((t) =>
        tool(t.name, t.description, t.shape, async (args) => {
          const toolUseId = this.pendingToolUseIds.get(t.name)?.shift();
          const input = unscratchPaths(args as Record<string, unknown>, scratch);
          if (t.name === 'Read' && typeof input.file_path === 'string') {
            const local = await readLocalSkillFile(skillDirs, input.file_path, input.offset as number | undefined, input.limit as number | undefined).catch(
              (e: unknown) => `Error: ${e instanceof Error ? e.message : String(e)}`,
            );
            if (local !== undefined) return { content: [{ type: 'text' as const, text: local }] };
          }
          const call = t.toProtocol(input);
          const result = await executor.call(call.name, call.args, {
            signal: this.abort?.signal,
            onOutput: (chunk, stream) => {
              if (toolUseId) this.record({ kind: 'tool_output', id: toolUseId, chunk, stream }, false);
            },
          });
          this.trackBackground(call, result.content, result.isError === true);
          return { content: [{ type: 'text' as const, text: result.content }], isError: result.isError ?? false };
        }),
      )],
    });
  }

  private trackBackground(call: { name: string; args: Record<string, unknown> }, content: string, isError: boolean): void {
    if (call.name === 'run_command' && call.args.background && !isError) {
      const id = /with id (\S+?)\./.exec(content)?.[1];
      if (id) this.background.set(id, { id, command: String(call.args.command), startedAt: Date.now() });
    } else if ((call.name === 'command_output' || call.name === 'command_kill') && typeof call.args.id === 'string') {
      if (isError || /exited|already|Stopping/.test(content.split('\n').pop() ?? content)) this.background.delete(call.args.id);
    }
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(msg);
    } catch (e) {
      if (this.q === q) {
        log(`session ${this.id} crashed: ${String(e)}`);
        this.record({ kind: 'error', message: e instanceof Error ? e.message : String(e) }, true);
      }
    } finally {
      if (this.q === q) {
        this.q = null;
        this.input = null;
        this.running.clear();
        this.turnStartedAt = undefined;
        this.setState('idle');
      }
    }
  }

  /** Queues the id for the MCP handler of the same tool and marks it running. Returns what clients should see. */
  private trackToolUse(id: string, rawName: string, input: unknown, parentId?: string): { name: string; input: unknown } {
    const name = rawName.startsWith(MCP_PREFIX) ? rawName.slice(MCP_PREFIX.length) : rawName;
    if (claudeTool(name) && rawName.startsWith(MCP_PREFIX)) {
      const queue = this.pendingToolUseIds.get(name) ?? [];
      queue.push(id);
      this.pendingToolUseIds.set(name, queue);
    }
    const shown = toDisplayCall(name, input);
    this.running.set(id, { id, name: shown.name, input: shown.input, startedAt: Date.now(), ...(parentId ? { parentId } : {}) });
    return shown;
  }

  /** A background subagent finishing makes Claude answer on its own, without a user turn. */
  private markWorking(): void {
    if (this.meta.state !== 'idle') return;
    this.turnStartedAt ??= Date.now();
    this.setState('running');
  }

  private trackTask(msg: Extract<SDKMessage, { type: 'system' }>): void {
    switch (msg.subtype) {
      case 'task_started':
        if (!msg.subagent_type && !/agent/i.test(msg.task_type ?? 'agent')) return;
        this.agents.set(msg.task_id, {
          id: msg.task_id,
          description: msg.description,
          ...(msg.subagent_type ? { type: msg.subagent_type } : {}),
          ...(msg.tool_use_id ? { toolUseId: msg.tool_use_id } : {}),
          startedAt: Date.now(),
        });
        return;
      case 'task_progress': {
        const a = this.agents.get(msg.task_id);
        if (a) this.agents.set(msg.task_id, { ...a, toolUses: msg.usage.tool_uses, ...(msg.last_tool_name ? { lastTool: toDisplayCall(msg.last_tool_name.replace(MCP_PREFIX, ''), {}).name } : {}) });
        return;
      }
      case 'task_notification':
        this.agents.delete(msg.task_id);
        return;
      case 'background_tasks_changed': {
        const live = new Set(msg.tasks.map((t) => t.task_id));
        for (const id of this.agents.keys()) if (!live.has(id)) this.agents.delete(id);
        return;
      }
      default:
        return;
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') this.host.onClaudeVersion(msg.claude_code_version);
        else this.trackTask(msg);
        return;
      case 'stream_event': {
        if (msg.parent_tool_use_id) return;
        this.markWorking();
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.streamedText = true;
          this.textBuffer += ev.delta.text;
          this.record({ kind: 'text_delta', text: ev.delta.text }, false);
        }
        return;
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) {
          for (const block of msg.message.content) if (block.type === 'tool_use') this.trackToolUse(block.id, block.name, block.input, msg.parent_tool_use_id);
          return;
        }
        this.markWorking();
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            if (!this.streamedText) this.host.emit(this.id, { kind: 'text_delta', text: block.text }, false);
            this.record({ kind: 'text', text: block.text }, true);
            this.setMeta({ lastText: block.text.slice(0, 200) });
            this.streamedText = false;
            this.textBuffer = '';
          } else if (block.type === 'tool_use') {
            const shown = this.trackToolUse(block.id, block.name, block.input);
            this.record({ kind: 'tool_use', id: block.id, name: shown.name, input: shown.input }, true);
          }
        }
        return;
      }
      case 'user': {
        const content = msg.message.content;
        if (typeof content === 'string') return;
        if (msg.parent_tool_use_id) {
          for (const block of content) if (block.type === 'tool_result') this.running.delete(block.tool_use_id);
          return;
        }
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          this.running.delete(block.tool_use_id);
          const text =
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
          this.record({ kind: 'tool_result', id: block.tool_use_id, content: text, isError: block.is_error ?? false }, true);
        }
        return;
      }
      case 'result': {
        if (msg.subtype !== 'success') this.record({ kind: 'error', message: `Claude stopped: ${msg.subtype}` }, true);
        this.record(
          {
            kind: 'result',
            durationMs: msg.duration_ms,
            costUsd: msg.total_cost_usd,
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
          },
          true,
        );
        this.running.clear();
        this.turnStartedAt = undefined;
        this.setState('idle');
        if (this.restartAfterTurn && !this.busy) {
          this.restartAfterTurn = false;
          this.stop();
          return;
        }
        this.applyPendingConfig();
        this.touch();
        return;
      }
      default:
        return;
    }
  }
}

function skillDirectories(): string[] {
  const dirs = [join(paths.skillsPlugin, 'skills'), paths.userSkills];
  try {
    dirs.push(realpathSync(paths.userSkills));
  } catch {}
  return dirs;
}

function scratchPrefixes(dir: string): string[] {
  const out = [dir];
  try {
    out.push(realpathSync(dir));
  } catch {}
  return out;
}

/** Claude sometimes reaches for its local working directory; on the executor that means the workspace root. */
function unscratchPaths(input: Record<string, unknown>, prefixes: readonly string[]): Record<string, unknown> {
  let out = input;
  for (const key of ['file_path', 'path']) {
    const v = input[key];
    if (typeof v !== 'string') continue;
    const prefix = prefixes.find((p) => v === p || v.startsWith(`${p}/`));
    if (prefix) out = { ...out, [key]: v.slice(prefix.length + 1) || '.' };
  }
  return out;
}

function readInstructions(dir: string): string | null {
  try {
    return readFileSync(join(dir, 'CLAUDE.md'), 'utf8').slice(0, 40_000);
  } catch {
    return null;
  }
}
