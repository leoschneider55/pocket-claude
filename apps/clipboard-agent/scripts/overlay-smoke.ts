/**
 * Shows the overlay window on Windows with a sample chat, clicks through it and saves screenshots: the window only runs on
 * Windows, so this is how a change to it gets looked at before it reaches a PC. CI runs it on windows-latest
 * (.github/workflows/overlay-windows.yml). Usage: tsx scripts/overlay-smoke.ts <output dir>
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { InnerMessageBody, ModelInfo, SessionEvent, SessionMeta } from '@pocket/protocol';
import { OverlayModel } from '../src/overlay/model.js';
import { OVERLAY_PS_FILE } from '../src/overlay/script.js';
import { OverlayWindow, type WindowEvent } from '../src/overlay/window.js';

const out = resolve(process.argv[2] ?? 'overlay-shots');
mkdirSync(out, { recursive: true });
const scriptFile = join(out, 'overlay.ps1');
writeFileSync(scriptFile, OVERLAY_PS_FILE);

const now = Date.now();
const MAIN = 'chat-fix';
const sessions: SessionMeta[] = [
  { sessionId: MAIN, title: 'Краш TypingBubble на Android', state: 'idle', createdAt: now - 3_600_000, updatedAt: now - 60_000, lastText: 'Почини, пожалуйста: приложение вылетает', model: 'opus', effort: 'max' },
  { sessionId: 'chat-overlay', title: 'Оверлей: читаемый дизайн', state: 'waiting_permission', createdAt: now - 7_200_000, updatedAt: now - 1_800_000, lastText: 'Сделай окно как чат' },
  { sessionId: 'chat-old', title: 'Скриншот экрана ноутбука', state: 'idle', createdAt: now - 3 * 86_400_000, updatedAt: now - 3 * 86_400_000, lastText: 'Что у меня на экране?' },
];

const tool = (id: string, name: string, input: unknown, content: string, isError = false): SessionEvent[] => [
  { kind: 'tool_use', id, name, input },
  { kind: 'tool_result', id, content, isError },
];

const histories: Record<string, SessionEvent[]> = {
  [MAIN]: [
    { kind: 'user', text: 'Что с оверлеем?', from: 'phone' },
    { kind: 'text', text: 'Сейчас посмотрю.' },
    ...tool('a1', 'read_file', { path: 'apps/clipboard-agent/src/overlay/script.ts' }, '1\t/**\n2\t * The overlay window'),
    ...tool('a2', 'grep', { pattern: 'RichTextBox', path: 'apps/clipboard-agent' }, 'script.ts:110: $rtb = New-Object Windows.Forms.RichTextBox'),
    { kind: 'error', message: 'Claude Code exited unexpectedly (code 1)' },
    { kind: 'user', text: 'Почини, пожалуйста: приложение вылетает с ошибкой «Rendered more hooks than during the previous render».', from: 'phone', images: 1 },
    { kind: 'text', text: 'Смотрю **TypingBubble** и `usePowerSaving`.' },
    ...tool('b1', 'grep', { pattern: 'TypingBubble|usePowerSaving', path: 'apps/mobile' }, 'src/components/TypingBubble.tsx:26\nsrc/power.ts:14'),
    ...tool('b2', 'read_file', { path: 'C:\\Users\\me\\pocket-claude\\apps\\mobile\\src\\components\\TypingBubble.tsx' }, '24\texport function TypingBubble() {\n25\t  const pulse = useScreenActive() && !usePowerSaving();'),
    ...tool('b3', 'run_command', { command: 'pnpm --filter @pocket/mobile test -- --run typing' }, 'FAIL  test/typing.test.ts\n  ✗ renders twice\nTests: 1 failed, 26 passed', true),
    ...tool('b4', 'edit_file', { path: 'apps/mobile/src/components/TypingBubble.tsx', old_string: 'const pulse = useScreenActive() && !usePowerSaving();', new_string: 'const active = useScreenActive();\nconst powerSaving = usePowerSaving();\nconst pulse = active && !powerSaving;' }, 'Edited 1 place'),
    ...tool('b5', 'run_command', { command: 'pnpm --filter @pocket/mobile typecheck && pnpm test' }, 'Tests: 27 passed'),
    {
      kind: 'text',
      text: [
        'Причина: `usePowerSaving()` вызывался через `&&`, то есть **не на каждом рендере**.',
        '',
        '- оба хука теперь вызываются всегда;',
        '- анимация осталась прежней.',
        '',
        '```tsx',
        'const active = useScreenActive();',
        'const powerSaving = usePowerSaving();',
        'const pulse = active && !powerSaving; // a very long comment line that has to wrap instead of scrolling sideways',
        '```',
      ].join('\n'),
    },
  ],
  'chat-overlay': [
    { kind: 'user', text: 'Сделай окно как чат', from: 'phone' },
    { kind: 'text', text: '# План\n1. Пузыри сообщений\n2. Действия отдельными строками\n3. Список чатов слева\n\n> Окно только читает переписку.' },
    { kind: 'tool_use', id: 'c1', name: 'run_command', input: { command: 'git push origin HEAD:overlay' } },
  ],
  'chat-old': [{ kind: 'user', text: 'Что у меня на экране?', from: 'phone' }, ...tool('d1', 'pc_screenshot', {}, 'Screenshot 1920x1080'), { kind: 'text', text: 'Открыт VS Code с проектом pocket-claude.' }],
};

const events: WindowEvent[] = [];
const problems: string[] = [];
const waiters: { from: number; pred: (e: WindowEvent) => boolean; done: (e: WindowEvent) => void }[] = [];

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const models: ModelInfo[] = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 4.1 for complex work' },
  { value: 'opus', displayName: 'Opus', description: 'Most capable for complex work', efforts: [...EFFORTS] },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Fast and capable for everyday tasks', efforts: ['low', 'medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers', efforts: ['low', 'medium', 'high'] },
];
const configured: unknown[] = [];

/** Plays the brain: lists, histories, models, a message typed in the window coming back with Claude's answer, model changes. */
function answer(body: InnerMessageBody): void {
  setTimeout(() => {
    if (body.type === 'models.get') model.handle({ type: 'models.result', payload: { models } });
    if (body.type === 'session.configure') {
      const { sessionId, model: m, effort } = body.payload;
      configured.push(body.payload);
      const i = sessions.findIndex((s) => s.sessionId === sessionId);
      const s = sessions[i];
      if (!s) return;
      const next: SessionMeta = { ...s, updatedAt: Date.now() };
      if (m !== undefined) next.model = m ?? undefined;
      if (effort !== undefined) next.effort = effort ?? undefined;
      sessions[i] = next;
      model.handle({ type: 'session.updated', payload: { session: next } });
    }
    if (body.type === 'session.list') model.handle({ type: 'session.list.result', payload: { sessions } });
    if (body.type === 'session.history') model.handle({ type: 'session.history.result', payload: { sessionId: body.payload.sessionId, events: histories[body.payload.sessionId] ?? [] } });
    if (body.type === 'message.send') {
      const { sessionId, text } = body.payload;
      const reply: SessionEvent[] = [
        { kind: 'user', text, from: 'pc' },
        { kind: 'tool_result', id: 'live1', content: 'Tests: 31 passed', isError: false },
        { kind: 'text_delta', text: 'Добавил тест: ' },
        { kind: 'text', text: 'Добавил тест: `TypingBubble` теперь рендерится дважды подряд без ошибки.' },
        { kind: 'state', state: 'idle' },
      ];
      reply.forEach((event, i) => setTimeout(() => model.handle({ type: 'session.event', payload: { sessionId, event } }), i * 200));
    }
  }, 50);
}

const overlay = new OverlayWindow({
  script: scriptFile,
  snapshot: () => model.snapshot(),
  log: (m) => {
    console.log(m);
    if (m.startsWith('overlay')) problems.push(m);
  },
  onEvent: (e) => {
    console.log('event', JSON.stringify(e));
    events.push(e);
    model.windowEvent(e);
    if (e.ev === 'theme') model.setTheme(e.theme);
    for (const w of [...waiters]) {
      if (events.length - 1 < w.from || !w.pred(e)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.done(e);
    }
  },
});
const model = new OverlayModel({ window: (op) => void overlay.send(op), request: answer });

/** The next event matching `pred`, counted from now. */
function next(pred: (e: WindowEvent) => boolean, ms: number, what: string): Promise<WindowEvent> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`timed out waiting for ${what}`)), ms);
    waiters.push({
      from: events.length,
      pred,
      done: (e) => {
        clearTimeout(timer);
        done(e);
      },
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ps(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
}

const UIA = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing',
  '$A = [System.Windows.Automation.AutomationElement]',
  "$win = $A::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Pocket')))",
  "if (-not $win) { throw 'overlay window not found' }",
].join('\n');

function find(id: string): string {
  return `$el = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, '${id}')))
if (-not $el) { throw 'no element ${id}' }`;
}

async function click(id: string): Promise<void> {
  ps(`${UIA}\n${find(id)}\n$el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()`);
  await sleep(700);
}

/** Types into a text field the way a screen reader would: no keyboard, so the editor keeps its focus. */
async function setValue(id: string, text: string): Promise<void> {
  ps(`${UIA}\n${find(id)}\n$el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('${text.replace(/'/g, "''")}')`);
  await sleep(400);
}

function nameOf(id: string): string {
  return ps(`${UIA}\n${find(id)}\n$el.Current.Name`).trim();
}

function expectName(id: string, want: string): void {
  const got = nameOf(id);
  if (got !== want) problems.push(`${id} reads ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}

function valueOf(id: string): string {
  return ps(`${UIA}\n${find(id)}\n$el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value`).trim();
}

/** Scrolls the transcript: 0 is the top, 100 the bottom. */
async function scrollTo(percent: number): Promise<void> {
  ps(`${UIA}
${find('transcript')}
$el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).SetScrollPercent(-1, ${percent})`);
  await sleep(400);
}

function shot(name: string): void {
  const file = join(out, `${name}.png`);
  ps(`${UIA}
$r = $win.Current.BoundingRectangle
$bmp = New-Object System.Drawing.Bitmap ([int]$r.Width), ([int]$r.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
$bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`);
  console.log(`saved ${file}`);
}

function doubleAlt(): void {
  ps(`Add-Type -Namespace Smoke -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'
foreach ($i in 1..2) { [Smoke.Keys]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [Smoke.Keys]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 120 }`);
}

function actionsId(index: number): { run: string; first: string } {
  const snap = model.snapshot();
  if (snap.op !== 'reset') throw new Error('no snapshot');
  const runs = snap.messages.filter((m) => m.role === 'actions');
  const run = runs[index];
  if (run?.role !== 'actions') throw new Error(`no run ${index}`);
  return { run: run.id, first: run.actions[0]!.id };
}

async function main(): Promise<void> {
  const ready = next((e) => e.ev === 'ready', 120_000, 'the window to start');
  overlay.start();
  await ready;
  model.connected();
  await sleep(1500);

  const shown = next((e) => e.ev === 'visible' && e.visible, 5000, 'double Alt to show the window');
  doubleAlt();
  await shown;
  await sleep(1200);
  shot('01-chat');
  await scrollTo(0);
  shot('02-chat-top');
  await scrollTo(100);

  const fix = actionsId(1);
  await click(`group:${fix.run}`);
  shot('03-actions-open');
  await click(`act:${fix.first}`);
  shot('04-action-details');

  await click('chats');
  shot('05-chats');
  const opened = next((e) => e.ev === 'open', 3000, 'a chat picked in the list');
  await click('chat:chat-overlay');
  await opened;
  await sleep(800);
  shot('06-other-chat');

  // The phone writes in the first chat again: the window follows it while Claude works.
  model.handle({ type: 'session.event', payload: { sessionId: MAIN, event: { kind: 'user', text: 'Проверь ещё раз тесты', from: 'phone' } } });
  await sleep(800);
  const live: SessionEvent[] = [
    { kind: 'state', state: 'running' },
    { kind: 'text_delta', text: 'Запускаю тесты.' },
    { kind: 'tool_use', id: 'live1', name: 'run_command', input: { command: 'pnpm test --filter @pocket/mobile -- --run' } },
    { kind: 'tool_output', id: 'live1', chunk: 'RUN  v3.2.7\n ✓ test/voice.test.ts (31 tests)\n', stream: 'stdout' },
  ];
  for (const event of live) {
    model.handle({ type: 'session.event', payload: { sessionId: MAIN, event } });
    await sleep(150);
  }
  await sleep(800);
  shot('07-live');

  // Writing from the window: the text goes out through the model and comes back as the chat's next message.
  const typed = 'Спасибо! Теперь добавь тест на TypingBubble.';
  await setValue('composer', typed);
  shot('08-typing');
  const sent = next((e) => e.ev === 'send', 3000, 'the send button');
  await click('send');
  const send = await sent;
  if (send.ev !== 'send' || send.chatId !== MAIN || send.text !== typed) problems.push(`unexpected send event ${JSON.stringify(send)}`);
  await sleep(1800);
  const left = valueOf('composer');
  if (left !== '') problems.push(`the input field still holds ${JSON.stringify(left)} after sending`);
  shot('09-sent');

  // Model and thinking: the chips show the chat's choice, the menus change it, the chat takes it.
  expectName('model', 'Модель: Opus');
  expectName('effort', 'Мышление: максимальное');
  await click('model');
  shot('10-model-menu');
  const picked = next((e) => e.ev === 'configure', 3000, 'a model picked in the menu');
  await click('model:sonnet');
  const pick = await picked;
  if (pick.ev !== 'configure' || pick.chatId !== MAIN || pick.model !== 'sonnet') problems.push(`unexpected configure event ${JSON.stringify(pick)}`);
  await sleep(900);
  // Sonnet has no "максимальное": the chat gets its nearest level.
  expectName('model', 'Модель: Sonnet');
  expectName('effort', 'Мышление: высокое');
  await click('effort');
  shot('11-effort-menu');
  const thought = next((e) => e.ev === 'configure', 3000, 'a thinking level picked in the menu');
  await click('effort:low');
  await thought;
  await sleep(900);
  expectName('effort', 'Мышление: низкое');
  const want = [
    { sessionId: MAIN, model: 'sonnet', effort: 'high' },
    { sessionId: MAIN, effort: 'low' },
  ];
  if (JSON.stringify(configured) !== JSON.stringify(want)) problems.push(`the brain got ${JSON.stringify(configured)}, expected ${JSON.stringify(want)}`);
  shot('12-picked');

  const themed = next((e) => e.ev === 'theme', 3000, 'the theme switch');
  await click('theme');
  await themed;
  await sleep(600);
  shot('13-light');
  await click('chats');
  shot('14-light-chats');
  await click('chats');

  const hidden = next((e) => e.ev === 'visible' && !e.visible, 3000, 'the hide button');
  await click('hide');
  await hidden;
}

main()
  .catch((e: unknown) => problems.push(e instanceof Error ? e.message : String(e)))
  .finally(async () => {
    overlay.close();
    await sleep(500);
    const errors = [...problems, ...events.flatMap((e) => (e.ev === 'error' ? [e.message] : []))];
    if (errors.length) {
      console.error(`overlay smoke test failed:\n${errors.join('\n')}`);
      process.exit(1);
    }
    console.log('overlay smoke test passed');
    process.exit(0);
  });
