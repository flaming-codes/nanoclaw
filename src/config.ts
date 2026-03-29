import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const ENV_KEY_ASSISTANT_NAME = 'ASSISTANT_NAME';
const ENV_KEY_ASSISTANT_HAS_OWN_NUMBER = 'ASSISTANT_HAS_OWN_NUMBER';
const ENV_KEY_ONECLI_URL = 'ONECLI_URL';
const ENV_KEY_CLAUDE_MODEL = 'CLAUDE_MODEL';
const ENV_KEY_ANTHROPIC_BASE_URL = 'ANTHROPIC_BASE_URL';
const ENV_KEY_ANTHROPIC_AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';
const ENV_KEY_TIMEZONE = 'TZ';

export const DEFAULT_ASSISTANT_NAME = 'Andy';
export const DEFAULT_CONTAINER_IMAGE = 'nanoclaw-agent:latest';
export const DEFAULT_ONECLI_URL = 'http://localhost:10254';
export const DEFAULT_CLAUDE_MODEL = 'minimax-m2.7:cloud';
export const DEFAULT_OLLAMA_BASE_URL = 'http://host.docker.internal:11434';
export const DEFAULT_OLLAMA_AUTH_TOKEN = 'ollama';

const envConfig = readEnvFile([
  ENV_KEY_ASSISTANT_NAME,
  ENV_KEY_ASSISTANT_HAS_OWN_NUMBER,
  ENV_KEY_ONECLI_URL,
  ENV_KEY_CLAUDE_MODEL,
  ENV_KEY_ANTHROPIC_BASE_URL,
  ENV_KEY_ANTHROPIC_AUTH_TOKEN,
  ENV_KEY_TIMEZONE,
]);

export const ASSISTANT_NAME =
  process.env[ENV_KEY_ASSISTANT_NAME] ||
  envConfig[ENV_KEY_ASSISTANT_NAME] ||
  DEFAULT_ASSISTANT_NAME;
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env[ENV_KEY_ASSISTANT_HAS_OWN_NUMBER] ||
    envConfig[ENV_KEY_ASSISTANT_HAS_OWN_NUMBER]) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || DEFAULT_CONTAINER_IMAGE;
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env[ENV_KEY_ONECLI_URL] ||
  envConfig[ENV_KEY_ONECLI_URL] ||
  DEFAULT_ONECLI_URL;
export const CLAUDE_MODEL =
  process.env[ENV_KEY_CLAUDE_MODEL] ||
  envConfig[ENV_KEY_CLAUDE_MODEL] ||
  DEFAULT_CLAUDE_MODEL;
export const ANTHROPIC_BASE_URL =
  process.env[ENV_KEY_ANTHROPIC_BASE_URL] ||
  envConfig[ENV_KEY_ANTHROPIC_BASE_URL] ||
  DEFAULT_OLLAMA_BASE_URL;
export const ANTHROPIC_AUTH_TOKEN =
  process.env[ENV_KEY_ANTHROPIC_AUTH_TOKEN] ||
  envConfig[ENV_KEY_ANTHROPIC_AUTH_TOKEN] ||
  DEFAULT_OLLAMA_AUTH_TOKEN;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env[ENV_KEY_TIMEZONE],
    envConfig[ENV_KEY_TIMEZONE],
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
