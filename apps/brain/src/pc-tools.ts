/* eslint-disable @typescript-eslint/no-explicit-any */
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import {
  MCP_SERVER_NAME,
  screenWatchSettingsPatchSchema,
  type ClipboardItem,
  type ComputerAction,
  type ComputerResult,
  type ScreenImage,
  type ScreenWatchSettings,
  type ScreenWatchStatus,
} from '@pocket/protocol';
import { z } from 'zod';

/** The user's own Windows computer with PocketClipboard on it, as a chat sees it; resolved on every use. */
export interface PcHandle {
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly online: boolean;
  readonly capabilities: readonly string[];
  clipboardRead(): Promise<{ items?: ClipboardItem[]; error?: string }>;
  clipboardWrite(item: ClipboardItem): Promise<{ error?: string }>;
  screenshot(): Promise<{ image?: ScreenImage; error?: string }>;
  /** Controls the watcher for this chat; the handle resolves the user's selected PC. */
  screenWatch?(enabled: boolean, goal?: string, settings?: Partial<ScreenWatchSettings>): Promise<{ status?: ScreenWatchStatus; error?: string }>;
  /** One computer-use step, in physical desktop pixels (the 'computer' capability). */
  computer(action: ComputerAction): Promise<ComputerResult & { error?: string }>;
}

export const PC_TOOL_NAMES = ['pc_clipboard_read', 'pc_clipboard_write', 'pc_screenshot', 'screen_watch'] as const;
export const PC_ALLOWED_TOOLS = PC_TOOL_NAMES.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`);

const isImageMime = (mime: string): mime is 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' => /^image\/(png|jpeg|gif|webp)$/.test(mime);
const TEXT_LIMIT = 100_000;

type Result = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text: string): Result => ({ content: [{ type: 'text', text }] });

/** What Claude is told about these tools, for every chat that has them. */
export function pcToolsPrompt(pcName: string | undefined): string {
  const who = pcName ? `"${pcName}"` : 'their Windows computer (none is online right now)';
  return [
    '# The user\'s own computer',
    `The user has PocketClipboard on ${who}. mcp__pocket__pc_clipboard_read shows what they copied there, mcp__pocket__pc_clipboard_write puts text there for them to paste with Ctrl+V, mcp__pocket__pc_screenshot shows you their screens.`,
    'When they ask you to put a command or text "in the clipboard" / "in the buffer", call pc_clipboard_write with exactly the text to paste (no markdown fences) and confirm in one short sentence. When they ask what is on their screen or to look at something, take a screenshot and describe what matters.',
    'Only when the user asks you to watch the screen, use screen_watch with action on; use action off when they ask you to stop. It controls only the computer selected for this chat.',
  ].join('\n');
}

export function pcTools(pc: () => PcHandle): SdkMcpToolDefinition<any>[] {
  const offline = (): Result | null => {
    const p = pc();
    if (!p.id) return fail('No computer with PocketClipboard is paired to this person. They can install PocketClipboard.exe and pair it from the app.');
    if (!p.online) return fail(`The computer "${p.name}" is offline: PocketClipboard is not running or the laptop is asleep.`);
    return null;
  };
  return [
    tool(
      'pc_clipboard_read',
      "Read what is on the clipboard of the user's Windows computer right now: text, an image (you will see it) or copied files.",
      {},
      async () => {
        const down = offline();
        if (down) return down;
        const p = pc();
        const r = await p.clipboardRead();
        if (r.error) return fail(`Clipboard read on "${p.name}" failed: ${r.error}`);
        const items = r.items ?? [];
        if (!items.length) return ok(`The clipboard of "${p.name}" is empty.`);
        const content: Result['content'] = [];
        for (const item of items) {
          if (item.kind === 'text') content.push({ type: 'text', text: item.text.length > TEXT_LIMIT ? `${item.text.slice(0, TEXT_LIMIT)}\n…[${item.text.length - TEXT_LIMIT} more characters]` : item.text });
          else if (item.kind === 'image' && isImageMime(item.mime)) content.push({ type: 'image', data: item.dataBase64, mimeType: item.mime });
          else if (item.kind === 'file') content.push({ type: 'text', text: `[Copied file: ${item.name}, ${item.mime}, ${item.size} bytes]` });
        }
        return { content: content.length ? content : [{ type: 'text', text: 'The clipboard holds data of a kind that cannot be shown.' }] };
      },
    ),
    tool(
      'pc_clipboard_write',
      "Put text on the clipboard of the user's Windows computer so they can paste it with Ctrl+V: a terminal command, code, a link. Pass exactly the text to paste, without markdown fences.",
      { text: z.string().min(1).max(1_000_000).describe('The exact text to put on the clipboard') },
      async ({ text }) => {
        const down = offline();
        if (down) return down;
        const p = pc();
        const r = await p.clipboardWrite({ kind: 'text', text });
        if (r.error) return fail(`Clipboard write on "${p.name}" failed: ${r.error}`);
        return ok(`Put ${text.length} characters on the clipboard of "${p.name}". The user can paste them with Ctrl+V.`);
      },
    ),
    tool(
      'pc_screenshot',
      "Take a screenshot of all screens of the user's Windows computer and look at it. Use it when the user asks what is on their screen or wants you to check something they see.",
      {},
      async () => {
        const down = offline();
        if (down) return down;
        const p = pc();
        if (!p.capabilities.includes('screenshot')) return fail(`PocketClipboard on "${p.name}" is too old to take screenshots; the user needs to install the current PocketClipboard.exe.`);
        const r = await p.screenshot();
        if (r.error || !r.image) return fail(`Screenshot of "${p.name}" failed: ${r.error ?? 'no image'}`);
        return {
          content: [
            { type: 'image', data: r.image.dataBase64, mimeType: r.image.mime },
            { type: 'text', text: `Screenshot of "${p.name}", ${r.image.width}x${r.image.height}, all monitors side by side.` },
          ],
        };
      },
    ),
    tool(
      'screen_watch',
      "Start or stop watching the screen of the user's selected computer. Use only when the user explicitly asks to watch or stop watching; an optional goal tells Claude what event to wait for.",
      {
        action: z.enum(['on', 'off']).describe('Whether to start or stop screen watching'),
        goal: z.string().max(1000).optional().describe('Optional event to watch for, such as a build finishing'),
        settings: screenWatchSettingsPatchSchema.optional().describe('Optional lower observation limits or sampling settings'),
      },
      async ({ action, goal, settings }) => {
        const control = pc().screenWatch;
        if (!control) return fail('Screen watching is unavailable in this chat.');
        const result = await control(action === 'on', goal, settings);
        if (result.error) return fail(result.error);
        if (result.status?.state === 'paused') return ok('Пауза наблюдения: много изменений.');
        if (result.status?.state === 'watching') return ok(`👁 Claude смотрит экран${result.status.goal ? `: ${result.status.goal}` : ''}.`);
        return ok('Наблюдение экрана выключено.');
      },
    ),
  ];
}
