import { describe, expect, it } from 'vitest';

import {
  getRegisteredGroupMatchForJid,
  hasRegisteredGroupTarget,
} from './registered-groups.js';
import { RegisteredGroup } from './types.js';

function createGroup(
  overrides: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return {
    name: 'Slack Main',
    folder: 'slack_main',
    trigger: '@Andy',
    added_at: '2026-03-30T00:00:00.000Z',
    isMain: true,
    requiresTrigger: false,
    ...overrides,
  };
}

describe('registered-groups', () => {
  it('matches exact JIDs directly', () => {
    const groups = {
      'slack:C123': createGroup(),
    };

    expect(getRegisteredGroupMatchForJid(groups, 'slack:C123')).toEqual({
      jid: 'slack:C123',
      group: groups['slack:C123'],
    });
  });

  it('matches wildcard JIDs', () => {
    const groups = {
      'slack:*': createGroup({ folder: 'all-slack' }),
    };

    expect(getRegisteredGroupMatchForJid(groups, 'slack:D123')).toEqual({
      jid: 'slack:*',
      group: groups['slack:*'],
    });
  });

  it('falls back Slack DMs to the single Slack main registration', () => {
    const groups = {
      'slack:C123': createGroup(),
    };

    expect(getRegisteredGroupMatchForJid(groups, 'slack:D123')).toEqual({
      jid: 'slack:C123',
      group: groups['slack:C123'],
    });
    expect(hasRegisteredGroupTarget(groups, 'slack:D123')).toBe(true);
  });

  it('does not guess a DM target when multiple Slack main registrations exist', () => {
    const groups = {
      'slack:C123': createGroup({ folder: 'main-one' }),
      'slack:C456': createGroup({ folder: 'main-two' }),
    };

    expect(getRegisteredGroupMatchForJid(groups, 'slack:D123')).toBeUndefined();
    expect(hasRegisteredGroupTarget(groups, 'slack:D123')).toBe(false);
  });
});
