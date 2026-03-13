import { describe, expect, it } from 'vitest';

import {
  createConversationId,
  formatConversationContinueCommand,
  formatConversationContinueInstruction,
  formatConversationKeepaliveMessage,
} from './conversations.js';

describe('conversations helpers', () => {
  it('creates short reusable conversation ids', () => {
    const conversationId = createConversationId();

    expect(conversationId).toMatch(/^[a-f0-9]{12}$/);
  });

  it('formats the follow-up command for an existing window', () => {
    expect(formatConversationContinueCommand('abc123def456')).toBe(
      'huddle "<message>" -c abc123def456',
    );
  });

  it('formats the keep-open instruction for the agent', () => {
    expect(formatConversationContinueInstruction('abc123def456')).toBe(
      'To respond invoke with huddle "<message>" -c abc123def456. That conversation_id corresponds to the existing open window.',
    );
  });

  it('formats the keepalive message for an open conversation', () => {
    expect(formatConversationKeepaliveMessage('abc123def456')).toBe(
      '[huddle keepalive] conversation_id=abc123def456',
    );
  });
});
