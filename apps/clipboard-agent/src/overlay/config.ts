import type { Effort, ModelInfo } from '@pocket/protocol';

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** What the window sends for "back to the default": the brain stores no model or no level then. */
export const DEFAULT_MODEL = 'default';
export const AUTO_EFFORT = 'auto';

const EFFORT_LABEL: Record<Effort, string> = { low: 'Низкое', medium: 'Среднее', high: 'Высокое', xhigh: 'Очень высокое', max: 'Максимальное' };
const EFFORT_HINT: Record<Effort, string> = {
  low: 'Быстрее всего, почти без размышлений',
  medium: 'Баланс скорости и рассуждений',
  high: 'Продумывает сложные задачи',
  xhigh: 'Глубокие рассуждения для трудной работы',
  max: 'Самый большой бюджет на размышления',
};

export interface PickerOption {
  value: string;
  label: string;
  detail: string;
  selected: boolean;
}

/** One picker under the input field: what it shows closed, and its menu. */
export interface OverlayPicker {
  title: string;
  label: string;
  options: PickerOption[];
}

/** The model and thinking level of the chat on screen. */
export interface OverlayConfig {
  model: OverlayPicker;
  effort: OverlayPicker;
  /** A change is on its way to the Mac. */
  pending: boolean;
}

export interface ChatChoice {
  model?: string;
  effort?: Effort;
}

/** What session.configure carries: `null` is back to the default. */
export interface ConfigPatch {
  model?: string | null;
  effort?: Effort | null;
}

export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);

/** The Mac's model list with "default" first, as on the phone. */
export function modelOptions(models: readonly ModelInfo[]): ModelInfo[] {
  if (models.some((m) => m.value === DEFAULT_MODEL)) return [...models];
  return [{ value: DEFAULT_MODEL, displayName: 'По умолчанию', description: 'Модель Claude Code по умолчанию' }, ...models];
}

/** Levels a model offers; one the list says nothing about gets all of them, as on the phone. */
export function effortsFor(model: string, models: readonly ModelInfo[]): readonly Effort[] {
  return models.find((m) => m.value === model)?.efforts ?? EFFORTS;
}

/** The level if the model has it, else the nearest lower one it has, else its lowest: what the brain does when Claude switches itself. */
export function fitEffort(effort: Effort, supported: readonly Effort[]): Effort {
  if (!supported.length || supported.includes(effort)) return effort;
  const rank = (e: Effort) => EFFORTS.indexOf(e);
  const sorted = [...supported].sort((a, b) => rank(a) - rank(b));
  return sorted.filter((e) => rank(e) <= rank(effort)).pop() ?? sorted[0]!;
}

export function applyPatch(choice: ChatChoice, patch: ConfigPatch | undefined): ChatChoice {
  if (!patch) return choice;
  return {
    model: patch.model !== undefined ? (patch.model ?? undefined) : choice.model,
    effort: patch.effort !== undefined ? (patch.effort ?? undefined) : choice.effort,
  };
}

/** The chat has taken every part of the patch. */
export function patchApplied(choice: ChatChoice, patch: ConfigPatch): boolean {
  return (patch.model === undefined || (patch.model ?? undefined) === choice.model) && (patch.effort === undefined || (patch.effort ?? undefined) === choice.effort);
}

const modelLabel = (m: ModelInfo) => (m.value === DEFAULT_MODEL ? 'По умолчанию' : m.displayName);

export function chatConfig(choice: ChatChoice, models: readonly ModelInfo[], pending: boolean): OverlayConfig {
  const current = choice.model ?? DEFAULT_MODEL;
  const options = modelOptions(models);
  const known = options.find((m) => m.value === current);
  return {
    model: {
      title: 'Модель',
      label: known ? modelLabel(known) : current,
      options: options.map((m) => ({ value: m.value, label: modelLabel(m), detail: m.description, selected: m.value === current })),
    },
    effort: {
      title: 'Мышление',
      label: choice.effort ? EFFORT_LABEL[choice.effort].toLowerCase() : 'авто',
      options: [
        { value: AUTO_EFFORT, label: 'Авто', detail: 'По умолчанию для модели', selected: !choice.effort },
        ...effortsFor(current, models).map((e) => ({ value: e, label: EFFORT_LABEL[e], detail: EFFORT_HINT[e], selected: choice.effort === e })),
      ],
    },
    pending,
  };
}

/**
 * Turns a pick in the window into a patch for the chat, or nothing when it changes nothing. A new model that lacks the
 * chat's thinking level gets the nearest level it has.
 */
export function configPatch(now: ChatChoice, change: { model?: string; effort?: string }, models: readonly ModelInfo[]): ConfigPatch | undefined {
  const patch: ConfigPatch = {};
  if (change.model) {
    const model = change.model === DEFAULT_MODEL ? null : change.model;
    if ((model ?? undefined) !== now.model) patch.model = model;
  }
  if (change.effort === AUTO_EFFORT) {
    if (now.effort) patch.effort = null;
  } else if (isEffort(change.effort) && change.effort !== now.effort) patch.effort = change.effort;
  if (patch.model !== undefined && patch.effort === undefined && now.effort) {
    const fitted = fitEffort(now.effort, effortsFor(patch.model ?? DEFAULT_MODEL, models));
    if (fitted !== now.effort) patch.effort = fitted;
  }
  return patch.model !== undefined || patch.effort !== undefined ? patch : undefined;
}
