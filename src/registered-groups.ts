import { RegisteredGroup } from './types.js';

function getWildcardGroupJid(
  groups: Record<string, RegisteredGroup>,
  jid: string,
): string | undefined {
  const match = /^([^:]+):/.exec(jid);
  if (!match) return undefined;

  const wildcardJid = `${match[1]}:*`;
  return groups[wildcardJid] ? wildcardJid : undefined;
}

function getSlackDirectMessageFallbackJid(
  groups: Record<string, RegisteredGroup>,
  jid: string,
): string | undefined {
  if (!/^slack:D/.test(jid)) return undefined;

  const slackMainGroups = Object.entries(groups).filter(
    ([groupJid, group]) =>
      groupJid.startsWith('slack:') &&
      groupJid !== 'slack:*' &&
      group.isMain === true,
  );

  if (slackMainGroups.length !== 1) return undefined;
  return slackMainGroups[0][0];
}

export function getRegisteredGroupMatchForJid(
  groups: Record<string, RegisteredGroup>,
  jid: string,
): { jid: string; group: RegisteredGroup } | undefined {
  const exactGroup = groups[jid];
  if (exactGroup) {
    return { jid, group: exactGroup };
  }

  const wildcardJid = getWildcardGroupJid(groups, jid);
  if (wildcardJid) {
    return { jid: wildcardJid, group: groups[wildcardJid] };
  }

  const fallbackJid = getSlackDirectMessageFallbackJid(groups, jid);
  if (fallbackJid) {
    return { jid: fallbackJid, group: groups[fallbackJid] };
  }

  return undefined;
}

export function hasRegisteredGroupTarget(
  groups: Record<string, RegisteredGroup>,
  jid: string,
): boolean {
  return Boolean(getRegisteredGroupMatchForJid(groups, jid));
}
