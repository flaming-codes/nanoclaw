import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getRecentMessagesForChat,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

const DEFAULT_FOLLOW_UP_PROMPTS = [
  {
    title: 'Summarize this',
    message: 'Summarize the key points from this conversation so far.',
  },
  {
    title: 'Action items',
    message:
      'List the concrete next actions or decisions from this conversation.',
  },
  {
    title: 'Draft reply',
    message: 'Draft a concise follow-up reply based on this conversation.',
  },
  {
    title: 'Risk check',
    message: 'Challenge the current plan and point out the main risks or gaps.',
  },
] as const;

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function getConversationJid(message: NewMessage): string {
  return message.conversation_jid || message.chat_jid;
}

function getWildcardGroupJid(jid: string): string | undefined {
  const match = /^([^:]+):/.exec(jid);
  if (!match) return undefined;

  const wildcardJid = `${match[1]}:*`;
  return registeredGroups[wildcardJid] ? wildcardJid : undefined;
}

function getRegisteredGroupMatch(
  jid: string,
): { jid: string; group: RegisteredGroup } | undefined {
  const channel = findChannel(channels, jid);
  const resolvedJid = channel?.resolveRegisteredJid?.(jid) || jid;

  const exactGroup = registeredGroups[resolvedJid];
  if (exactGroup) {
    return { jid: resolvedJid, group: exactGroup };
  }

  const wildcardJid = getWildcardGroupJid(resolvedJid);
  if (wildcardJid) {
    return { jid: wildcardJid, group: registeredGroups[wildcardJid] };
  }

  return undefined;
}

function isRegisteredChatJid(jid: string): boolean {
  return getRegisteredGroupMatch(jid) !== undefined;
}

function getTrackedChatJids(): string[] {
  const trackedJids = new Set<string>();

  for (const jid of Object.keys(registeredGroups)) {
    if (!jid.endsWith(':*')) {
      trackedJids.add(jid);
    }
  }

  for (const chat of getAllChats()) {
    if (chat.jid === '__group_sync__') continue;
    const wildcardJid = chat.channel ? `${chat.channel}:*` : undefined;
    if (wildcardJid && registeredGroups[wildcardJid]) {
      trackedJids.add(chat.jid);
    }
  }

  return [...trackedJids];
}

function resolveRegisteredChatJid(jid: string): string {
  return getRegisteredGroupMatch(jid)?.jid || jid;
}

function getSessionKey(
  group: RegisteredGroup,
  conversationJid?: string,
): string {
  if (!conversationJid) return group.folder;
  const registeredJid = resolveRegisteredChatJid(conversationJid);
  return registeredJid === conversationJid
    ? group.folder
    : `${group.folder}:${conversationJid}`;
}

function getReactionAnchor(messages: NewMessage[]): NewMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message.is_from_me && !message.is_bot_message) {
      return message;
    }
  }
  return undefined;
}

function buildConversationTitle(messages: NewMessage[]): string | undefined {
  const firstUserMessage = messages.find(
    (message) => !message.is_from_me && !message.is_bot_message,
  );
  if (!firstUserMessage) return undefined;

  const normalized = firstUserMessage.content
    .replace(/^@\S+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return undefined;
  return normalized.slice(0, 80);
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(conversationJid: string): string {
  const existing = lastAgentTimestamp[conversationJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(conversationJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { conversationJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[conversationJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: isRegisteredChatJid(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(conversationJid: string): Promise<boolean> {
  const groupJid = resolveRegisteredChatJid(conversationJid);
  const group = registeredGroups[groupJid];
  if (!group) return true;

  const channel = findChannel(channels, conversationJid);
  if (!channel) {
    logger.warn({ conversationJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    conversationJid,
    getOrRecoverCursor(conversationJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(groupJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const sessionKey = getSessionKey(group, conversationJid);
  const hasExistingSession = Boolean(sessions[sessionKey]);
  const conversationTitle = buildConversationTitle(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[conversationJid] || '';
  lastAgentTimestamp[conversationJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(conversationJid);
    }, IDLE_TIMEOUT);
  };

  const reactionAnchor = getReactionAnchor(missedMessages);
  if (reactionAnchor && channel.setReaction) {
    await channel
      .setReaction(conversationJid, reactionAnchor.id, 'eyes', true)
      .catch((err) =>
        logger.debug(
          { conversationJid, reaction: 'eyes', err },
          'Failed to add Slack processing reaction',
        ),
      );
  }

  if (!hasExistingSession && conversationTitle) {
    await channel
      .setConversationTitle?.(conversationJid, conversationTitle)
      .catch((err) =>
        logger.debug(
          { conversationJid, err },
          'Failed to set platform conversation title',
        ),
      );
  }

  await channel.setTyping?.(conversationJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let latestOutputText: string | null = null;

  const output = await runAgent(
    group,
    prompt,
    conversationJid,
    async (result) => {
      // The SDK may emit multiple successive result snapshots for a single turn.
      // Keep only the latest clean text and send it once after the run completes.
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          latestOutputText = text;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(conversationJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(conversationJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (latestOutputText) {
    await channel.sendMessage(conversationJid, latestOutputText);
    outputSentToUser = true;

    await channel
      .setSuggestedPrompts?.(
        conversationJid,
        [...DEFAULT_FOLLOW_UP_PROMPTS],
        'Try a follow-up',
      )
      .catch((err) =>
        logger.debug(
          { conversationJid, err },
          'Failed to publish platform suggested prompts',
        ),
      );
  }

  if (reactionAnchor && channel.setReaction) {
    await channel
      .setReaction(conversationJid, reactionAnchor.id, 'eyes', false)
      .catch((err) =>
        logger.debug(
          { conversationJid, reaction: 'eyes', err },
          'Failed to remove Slack processing reaction',
        ),
      );

    const finalReaction =
      outputSentToUser || (output !== 'error' && !hadError)
        ? 'white_check_mark'
        : 'x';
    await channel
      .setReaction(conversationJid, reactionAnchor.id, finalReaction, true)
      .catch((err) =>
        logger.debug(
          { conversationJid, reaction: finalReaction, err },
          'Failed to apply final Slack reaction',
        ),
      );
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[conversationJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  conversationJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionKey = getSessionKey(group, conversationJid);
  const sessionId = sessions[sessionKey];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[sessionKey] = output.newSessionId;
          setSession(sessionKey, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid: conversationJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(
          conversationJid,
          proc,
          containerName,
          group.folder,
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = getTrackedChatJids();
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const conversationJid = getConversationJid(msg);
          const existing = messagesByGroup.get(conversationJid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(conversationJid, [msg]);
          }
        }

        for (const [conversationJid, groupMessages] of messagesByGroup) {
          const groupJid = resolveRegisteredChatJid(conversationJid);
          const group = registeredGroups[groupJid];
          if (!group) continue;

          const channel = findChannel(channels, conversationJid);
          if (!channel) {
            logger.warn(
              { conversationJid },
              'No channel owns JID, skipping messages',
            );
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(groupJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            conversationJid,
            getOrRecoverCursor(conversationJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(conversationJid, formatted)) {
            logger.debug(
              { conversationJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[conversationJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(conversationJid, true)
              ?.catch((err) =>
                logger.warn(
                  { conversationJid, err },
                  'Failed to set typing indicator',
                ),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(conversationJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const chatJid of getTrackedChatJids()) {
    const match = getRegisteredGroupMatch(chatJid);
    if (!match) continue;

    const recent = getRecentMessagesForChat(
      chatJid,
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    const pendingByConversation = new Map<string, number>();

    for (const message of recent) {
      const conversationJid = getConversationJid(message);
      if (message.timestamp > getOrRecoverCursor(conversationJid)) {
        pendingByConversation.set(
          conversationJid,
          (pendingByConversation.get(conversationJid) || 0) + 1,
        );
      }
    }

    for (const [conversationJid, pendingCount] of pendingByConversation) {
      logger.info(
        { group: match.group.name, conversationJid, pendingCount },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(conversationJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = getRegisteredGroupMatch(chatJid)?.group;
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      const groupMatch = getRegisteredGroupMatch(chatJid);

      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && groupMatch) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(groupMatch.jid, cfg) &&
          !isSenderAllowed(groupMatch.jid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid: groupMatch.jid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
