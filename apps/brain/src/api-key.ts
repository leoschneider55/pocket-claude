import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './store.js';

/**
 * The owner's Anthropic API key for chats switched to API billing. Kept only in this file (mode 600), never in state,
 * logs or events; Claude Code gets it as ANTHROPIC_API_KEY and talks to api.anthropic.com with it directly.
 */
const file = () => join(paths.home, 'anthropic-api-key');

export function readApiKey(): string | undefined {
  try {
    return readFileSync(file(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function saveApiKey(key: string): void {
  const k = key.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new Error('This does not look like an Anthropic API key (sk-ant-…).');
  writeFileSync(file(), `${k}\n`, { mode: 0o600 });
  chmodSync(file(), 0o600);
}

export function removeApiKey(): void {
  rmSync(file(), { force: true });
}

/** Enough to tell keys apart, never enough to use one. */
export function maskApiKey(key: string): string {
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}
