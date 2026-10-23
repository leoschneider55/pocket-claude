import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const roleSchema = z.enum(['brain', 'executor', 'client']);
export type Role = z.infer<typeof roleSchema>;

export const sessionStateSchema = z.enum(['idle', 'running', 'waiting_permission', 'ended']);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;

const watchSettingFields = {
  intervalMs: z.number().int().min(500).max(3000),
  changeThreshold: z.number().min(0.01).max(1),
  settleMs: z.number().int().min(500).max(5000),
  display: z.number().int().min(0),
  maxPerMinute: z.number().int().min(1).max(4),
  maxPerHour: z.number().int().min(1).max(60),
  retainFrames: z.number().int().min(1).max(10),
};
export const screenWatchSettingsPatchSchema = z.object(watchSettingFields).partial();
export const screenWatchSettingsSchema = z.object({
  intervalMs: watchSettingFields.intervalMs.default(1000),
  changeThreshold: watchSettingFields.changeThreshold.default(0.08),
  settleMs: watchSettingFields.settleMs.default(1500),
  display: watchSettingFields.display.default(0),
  maxPerMinute: watchSettingFields.maxPerMinute.default(4),
  maxPerHour: watchSettingFields.maxPerHour.default(60),
  retainFrames: watchSettingFields.retainFrames.default(2),
});
export type ScreenWatchSettings = z.infer<typeof screenWatchSettingsSchema>;
export const DEFAULT_SCREEN_WATCH_SETTINGS: Readonly<ScreenWatchSettings> = Object.freeze(screenWatchSettingsSchema.parse({}));

const watchIdSchema = z.string().min(1).max(128);
const watchGoalSchema = z.string().max(1000);
export const screenWatchReasonSchema = z.enum(['user', 'idle', 'locked', 'sleep', 'offline', 'limit', 'error', 'killed', 'replaced']);
export type ScreenWatchReason = z.infer<typeof screenWatchReasonSchema>;
export const screenWatchStatusSchema = z.object({
  sessionId: watchIdSchema,
  watchId: watchIdSchema,
  deviceId: watchIdSchema,
  state: z.enum(['off', 'watching', 'paused']),
  reason: screenWatchReasonSchema.optional(),
  goal: watchGoalSchema.optional(),
  settings: screenWatchSettingsSchema,
});
export type ScreenWatchStatus = z.infer<typeof screenWatchStatusSchema>;

export const sessionMetaSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  state: sessionStateSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  lastText: z.string().optional(),
  model: z.string().optional(),
  effort: effortSchema.optional(),
  /** The computer this chat works on; unset means the account's active computer. */
  executorId: z.string().optional(),
  /** Project folder on that computer; unset means the folders open in VS Code. */
  project: z.string().optional(),
  /** Hidden from the chat list on clients, still kept on the brain. */
  hidden: z.boolean().optional(),
  /** The person the chat belongs to; the brain shows each client only its own person's chats. */
  userId: z.string().optional(),
  watch: screenWatchStatusSchema.optional(),
  /** Claude Code session behind this chat; it is tied to a working directory, so moving the chat starts a new one. */
  engine: z.object({ id: z.string(), cwd: z.string() }).optional(),
});
export type SessionMeta = z.infer<typeof sessionMetaSchema>;

/** Normalised Claude Code activity, independent of the CLI's stream-json shape. */
export const sessionEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    text: z.string(),
    from: z.string(),
    images: z.number().int().positive().optional(),
    files: z.array(z.string()).optional(),
    /** Spoken on a call. */
    voice: z.boolean().optional(),
    observation: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('text_delta'), text: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string(), observation: z.boolean().optional() }),
  z.object({ kind: z.literal('screen_watch'), at: z.number(), text: z.string() }),
  z.object({ kind: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ kind: z.literal('tool_output'), id: z.string(), chunk: z.string(), stream: z.enum(['stdout', 'stderr']) }),
  z.object({ kind: z.literal('tool_result'), id: z.string(), content: z.string(), isError: z.boolean() }),
  z.object({ kind: z.literal('state'), state: sessionStateSchema }),
  z.object({
    kind: z.literal('result'),
    durationMs: z.number().optional(),
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    observation: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const permissionDecisionSchema = z.enum(['allow', 'allow_session', 'deny']);
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

/** Photos are shown to Claude directly; other files are saved next to the chat and Claude reads them by path. */
export const attachmentSchema = z.object({ mime: z.string(), dataBase64: z.string(), name: z.string().max(255).optional() });
export type Attachment = z.infer<typeof attachmentSchema>;

export const clipboardItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('image'), mime: z.string(), dataBase64: z.string() }),
  z.object({ kind: z.literal('file'), name: z.string(), mime: z.string(), dataBase64: z.string(), size: z.number() }),
]);
export type ClipboardItem = z.infer<typeof clipboardItemSchema>;

/** A downscaled picture of a computer's screen (all monitors), small enough for Claude to look at. */
export const screenImageSchema = z.object({ mime: z.string(), dataBase64: z.string(), width: z.number().int().positive(), height: z.number().int().positive() });
export type ScreenImage = z.infer<typeof screenImageSchema>;

const changedRegionSchema = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine((region) => region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001, 'Region must fit the selected display');

/** Only observation images are bounded; manual screenshots and zoom keep their existing format. */
export const screenWatchFrameSchema = z.object({
  sessionId: watchIdSchema,
  watchId: watchIdSchema,
  frameId: watchIdSchema,
  capturedAt: z.number().int().nonnegative(),
  image: screenImageSchema.extend({
    mime: z.literal('image/jpeg'),
    dataBase64: z.string().min(1).max(4_000_000),
    width: z.number().int().positive().max(1280),
    height: z.number().int().positive().max(800),
  }),
  windowTitle: z.string().max(2048),
  processName: z.string().max(260),
  display: z.number().int().min(0),
  changedRegion: changedRegionSchema.optional(),
  requestId: watchIdSchema.optional(),
});
export type ScreenWatchFrame = z.infer<typeof screenWatchFrameSchema>;

const px = z.number().int();
const size = z.number().int().positive();
const mouseButtonSchema = z.enum(['left', 'right', 'middle']);
/** Key names held during a click or scroll, e.g. ["ctrl"], ["shift"]. */
const modifiersSchema = z.array(z.string().min(1).max(20)).max(4).optional();

/** A monitor of a computer, in physical pixels of the whole desktop. */
export const displaySchema = z.object({
  index: z.number().int().min(0),
  x: px,
  y: px,
  width: size,
  height: size,
  primary: z.boolean(),
  /** 1.25 for a display set to 125 %. */
  scale: z.number().positive().optional(),
});
export type Display = z.infer<typeof displaySchema>;

export const windowInfoSchema = z.object({
  /** The window handle as a decimal string; pass it back to act on the window. */
  handle: z.string(),
  title: z.string(),
  process: z.string(),
  x: px,
  y: px,
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  minimized: z.boolean(),
  maximized: z.boolean(),
  focused: z.boolean(),
  /** Index of the display the window is on; absent for minimized windows. */
  display: z.number().int().min(0).optional(),
});
export type WindowInfo = z.infer<typeof windowInfoSchema>;

/**
 * One step of computer use on a PocketClipboard computer. Coordinates are physical pixels of the whole desktop;
 * the brain converts from screenshot pixels. `key` takes xdotool-style names: "ctrl+shift+esc", "Return", "super+r".
 */
export const computerActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('screenshot'), display: z.number().int().min(0).optional(), maxWidth: z.number().int().min(200).max(4000).optional(), maxHeight: z.number().int().min(200).max(4000).optional() }),
  z.object({ action: z.literal('zoom'), x: px, y: px, width: size, height: size, maxWidth: z.number().int().min(200).max(4000).optional(), maxHeight: z.number().int().min(200).max(4000).optional() }),
  z.object({ action: z.literal('move'), x: px, y: px }),
  /** Without x/y the click lands where the pointer is. */
  z.object({ action: z.literal('click'), x: px.optional(), y: px.optional(), button: mouseButtonSchema, count: z.number().int().min(1).max(3), modifiers: modifiersSchema }),
  z.object({ action: z.literal('button'), button: mouseButtonSchema, down: z.boolean() }),
  z.object({ action: z.literal('drag'), path: z.array(z.tuple([px, px])).min(2).max(50), button: mouseButtonSchema.optional() }),
  /** Wheel notches: dy > 0 scrolls down, dx > 0 scrolls right. */
  z.object({ action: z.literal('scroll'), x: px.optional(), y: px.optional(), dx: z.number().int().min(-50).max(50), dy: z.number().int().min(-50).max(50), modifiers: modifiersSchema }),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(20_000) }),
  z.object({ action: z.literal('key'), keys: z.string().min(1).max(200), holdMs: z.number().int().min(0).max(10_000).optional() }),
  z.object({ action: z.literal('cursor') }),
  z.object({ action: z.literal('windows') }),
  z.object({ action: z.literal('window'), handle: z.string().regex(/^\d+$/), op: z.enum(['focus', 'minimize', 'maximize', 'restore', 'close']) }),
  /** A program, file, folder or URL, as the Run dialog takes it: "powershell", "chrome", "https://…", "notepad". */
  z.object({ action: z.literal('open'), target: z.string().min(1).max(2000), args: z.string().max(8000).optional() }),
  /** Lets go of every key and mouse button: what the kill switch does. */
  z.object({ action: z.literal('release') }),
]);
export type ComputerAction = z.infer<typeof computerActionSchema>;

/** What a step returns; screenshots and zooms say which part of the desktop the picture shows. */
export const computerResultSchema = z.object({
  image: screenImageSchema.optional(),
  region: z.object({ x: px, y: px, width: size, height: size }).optional(),
  displays: z.array(displaySchema).optional(),
  cursor: z.object({ x: px, y: px }).optional(),
  windows: z.array(windowInfoSchema).optional(),
  text: z.string().optional(),
});
export type ComputerResult = z.infer<typeof computerResultSchema>;

export const modelInfoSchema = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
  efforts: z.array(effortSchema).optional(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const runningToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  startedAt: z.number(),
  /** Set for tools called by a subagent: the id of the Agent tool use that spawned it. */
  parentId: z.string().optional(),
});
export type RunningTool = z.infer<typeof runningToolSchema>;

export const backgroundTaskSchema = z.object({ id: z.string(), command: z.string(), startedAt: z.number() });
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;

export const subagentSchema = z.object({
  id: z.string(),
  description: z.string(),
  type: z.string().optional(),
  /** The Agent tool use that started it; tools with this `parentId` belong to it. */
  toolUseId: z.string().optional(),
  startedAt: z.number(),
  lastTool: z.string().optional(),
  toolUses: z.number().optional(),
});
export type Subagent = z.infer<typeof subagentSchema>;

export const activitySessionSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  state: sessionStateSchema,
  live: z.boolean(),
  executorId: z.string().optional(),
  project: z.string().optional(),
  model: z.string().optional(),
  effort: effortSchema.optional(),
  runningTools: z.array(runningToolSchema),
  background: z.array(backgroundTaskSchema).optional(),
  agents: z.array(subagentSchema).optional(),
  pendingPermissions: z.number(),
  turnStartedAt: z.number().optional(),
});
export type ActivitySession = z.infer<typeof activitySessionSchema>;

export const projectSchema = z.object({
  path: z.string(),
  name: z.string(),
  /** Open in a VS Code window right now. */
  open: z.boolean(),
  lastOpened: z.number().optional(),
});
export type Project = z.infer<typeof projectSchema>;

/** Pseudo device id for "work on the Mac itself" in computer.select. */
export const MAC_DEVICE_ID = 'mac';

export const computerSchema = z.object({
  deviceId: z.string(),
  name: z.string(),
  online: z.boolean(),
  os: z.string().optional(),
  workspaces: z.array(z.string()),
  projects: z.array(projectSchema).optional(),
  capabilities: z.array(z.string()).optional(),
  pairedAt: z.number(),
});
export type Computer = z.infer<typeof computerSchema>;

const m = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });

export const innerMessageBodySchema = z.discriminatedUnion('type', [
  // client → brain
  m('session.create', z.object({ title: z.string().optional() })),
  m('session.list', z.object({})),
  m('session.history', z.object({ sessionId: z.string() })),
  /** `voice`: the text was spoken on a call and the reply will be read aloud; the brain asks Claude for a short spoken answer. */
  m('message.send', z.object({ sessionId: z.string(), text: z.string(), attachments: z.array(attachmentSchema).optional(), voice: z.boolean().optional() })),
  m('session.interrupt', z.object({ sessionId: z.string() })),
  m('permission.respond', z.object({ requestId: z.string(), decision: permissionDecisionSchema })),
  m('status.get', z.object({})),
  m('session.configure', z.object({ sessionId: z.string(), model: z.string().nullable().optional(), effort: effortSchema.nullable().optional() })),
  m('session.rename', z.object({ sessionId: z.string(), title: z.string().min(1).max(80) })),
  m('session.hide', z.object({ sessionId: z.string(), hidden: z.boolean() })),
  m('session.delete', z.object({ sessionId: z.string() })),
  m('models.get', z.object({})),
  m('activity.get', z.object({})),
  m('computers.get', z.object({})),
  /** Binds a chat to a computer (when `sessionId` is set) and makes it the default for new chats. */
  m('computer.select', z.object({ deviceId: z.string(), sessionId: z.string().optional(), project: z.string().nullable().optional() })),
  /** Opens a project folder in a new VS Code window on that computer. */
  m('computer.open', z.object({ deviceId: z.string(), path: z.string() })),
  m('computer.pair', z.object({})),
  /** Asks a computer for what is on its clipboard right now. */
  m('clipboard.get', z.object({ requestId: z.string(), deviceId: z.string() })),
  m('clipboard.set', z.object({ requestId: z.string(), deviceId: z.string(), item: clipboardItemSchema })),
  /** Asks a computer for a picture of its screen right now. */
  m('screen.get', z.object({ requestId: z.string(), deviceId: z.string() })),
  /** The brain resolves the PC from this person's chat; clients cannot choose another person's device. */
  m('screen.watch.set', z.object({ sessionId: watchIdSchema, enabled: z.boolean(), goal: watchGoalSchema.optional(), settings: screenWatchSettingsPatchSchema.optional() })),
  m('computer.remove', z.object({ deviceId: z.string() })),
  /** Owner only: asks for an invite link that registers a new person with their own phone, computers and chats. */
  m('user.invite', z.object({})),
  /** Asks for a link that connects the Mac's Telegram bot to this person; answered with `telegram.linking`. */
  m('telegram.link', z.object({})),
  /** The sending device leaves the account: the brain forgets it. */
  m('device.unpair', z.object({})),

  // brain → client
  m('host.status', z.object({
    ready: z.boolean(),
    reason: z.string().optional(),
    claudeVersion: z.string().optional(),
    executorOnline: z.boolean(),
    workspaces: z.array(z.string()),
    /** Who this client belongs to. Owners may work on the Mac itself and invite people. */
    user: z.object({ id: z.string(), name: z.string(), owner: z.boolean() }).optional(),
    /** Username of the Telegram bot set up on the Mac, when there is one. */
    telegramBot: z.string().optional(),
  })),
  m('session.created', z.object({ session: sessionMetaSchema })),
  m('session.list.result', z.object({ sessions: z.array(sessionMetaSchema) })),
  m('session.history.result', z.object({ sessionId: z.string(), events: z.array(sessionEventSchema) })),
  m('session.updated', z.object({ session: sessionMetaSchema })),
  m('session.deleted', z.object({ sessionId: z.string() })),
  m('session.event', z.object({ sessionId: z.string(), event: sessionEventSchema })),
  m('permission.request', z.object({
    requestId: z.string(),
    sessionId: z.string(),
    tool: z.string(),
    input: z.unknown(),
    expiresAt: z.number(),
  })),
  m('permission.resolved', z.object({ requestId: z.string(), decision: permissionDecisionSchema, by: z.string() })),
  m('error', z.object({ code: z.string(), message: z.string() })),
  m('models.result', z.object({ models: z.array(modelInfoSchema) })),
  /** `activeId` is the default computer for the clipboard; `mac` lists projects chats can work in on the Mac itself. */
  m('computers.result', z.object({
    computers: z.array(computerSchema),
    activeId: z.string().nullable(),
    mac: z.object({ name: z.string(), projects: z.array(projectSchema) }).optional(),
  })),
  /** `uri` is the same code as a pocketclaude://pair link with the relay inside: one paste or one QR scan for PocketClipboard. */
  m('computer.pairing', z.object({ code: z.string(), safetyNumber: z.string(), expiresAt: z.number(), uri: z.string().optional() })),
  m('user.invitation', z.object({ uri: z.string(), code: z.string(), safetyNumber: z.string(), expiresAt: z.number() })),
  /** `url` opens the bot with the pairing code as its start parameter. */
  m('telegram.linking', z.object({ url: z.string(), code: z.string(), expiresAt: z.number() })),
  m('clipboard.result', z.object({ requestId: z.string(), deviceId: z.string(), items: z.array(clipboardItemSchema).optional(), error: z.string().optional() })),
  m('clipboard.written', z.object({ requestId: z.string(), deviceId: z.string(), error: z.string().optional() })),
  m('screen.result', z.object({ requestId: z.string(), deviceId: z.string(), image: screenImageSchema.optional(), error: z.string().optional() })),
  m('activity.result', z.object({
    at: z.number(),
    sessions: z.array(activitySessionSchema),
    executor: z.object({ online: z.boolean(), workspaces: z.array(z.string()), os: z.string().optional() }),
    claudeVersion: z.string().optional(),
  })),

  // brain ↔ executor
  /** `root` limits the call to one project folder; without it the executor uses the folders open in VS Code. */
  m('tool.call', z.object({ callId: z.string(), name: z.string(), args: z.unknown(), root: z.string().optional() })),
  m('workspace.open', z.object({ path: z.string() })),
  m('clipboard.read', z.object({ requestId: z.string() })),
  m('clipboard.write', z.object({ requestId: z.string(), item: clipboardItemSchema })),
  m('clipboard.data', z.object({ requestId: z.string(), items: z.array(clipboardItemSchema).optional(), error: z.string().optional() })),
  m('clipboard.done', z.object({ requestId: z.string(), error: z.string().optional() })),
  m('screen.capture', z.object({ requestId: z.string() })),
  m('screen.image', z.object({ requestId: z.string(), image: screenImageSchema.optional(), error: z.string().optional() })),
  m('screen.watch.control', z.object({ sessionId: watchIdSchema, watchId: watchIdSchema, enabled: z.boolean(), settings: screenWatchSettingsSchema, goal: watchGoalSchema.optional() })),
  m('screen.watch.capture', z.object({ sessionId: watchIdSchema, watchId: watchIdSchema, requestId: watchIdSchema })),
  m('screen.watch.frame', screenWatchFrameSchema),
  m('screen.watch.status', screenWatchStatusSchema),
  /** Computer use on a computer with the 'computer' capability (PocketClipboard on Windows). */
  m('computer.act', z.object({ requestId: z.string(), action: computerActionSchema })),
  m('computer.done', computerResultSchema.extend({ requestId: z.string(), error: z.string().optional() })),
  m('tool.result', z.object({ callId: z.string(), content: z.string(), isError: z.boolean() })),
  m('tool.output', z.object({ callId: z.string(), chunk: z.string(), stream: z.enum(['stdout', 'stderr']) })),
  m('tool.cancel', z.object({ callId: z.string() })),
  m('executor.status', z.object({
    workspaces: z.array(z.string()),
    os: z.string(),
    shell: z.string(),
    projects: z.array(projectSchema).optional(),
    /**
     * What this computer offers: 'tools' (VS Code extension), 'clipboard' (PocketClipboard), 'screenshot' (PocketClipboard answers screen.capture),
     * 'overlay' (PocketClipboard shows the chat on screen: it receives session events, may list sessions, read history and write text into its person's chats),
     * 'computer' (PocketClipboard answers computer.act: screen, mouse, keyboard, windows),
     * 'watch' (PocketClipboard samples its unlocked screen in the persistent computer host).
     */
    capabilities: z.array(z.string()).optional(),
    watch: screenWatchStatusSchema.optional(),
  })),

  // brain → every device
  /** The relay has a new public address: save it and reconnect there. */
  m('relay.moved', z.object({ url: z.string().url() })),

  // any → any
  m('control.kill', z.object({ scope: z.literal('all') })),
]);

export type InnerMessageBody = z.infer<typeof innerMessageBodySchema>;
export type MessageType = InnerMessageBody['type'];
export type PayloadOf<T extends MessageType> = Extract<InnerMessageBody, { type: T }>['payload'];

export const innerMessageSchema = z.intersection(
  z.object({ ts: z.number(), counter: z.number() }),
  innerMessageBodySchema,
);
export type InnerMessage = z.infer<typeof innerMessageSchema>;
