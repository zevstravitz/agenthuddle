import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export interface HuddleConversationPaths {
  conversationDir: string;
  metadataPath: string;
  readyPath: string;
  closedPath: string;
  requestsDir: string;
  responsesDir: string;
}

export interface HuddleConversationMetadata {
  conversationId: string;
  conversationDir: string;
  createdAt: string;
  cwd: string;
  pid: number | null;
  title: string;
}

export function createConversationId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function resolveConversationRootDir(): string {
  return path.join(homedir(), '.huddle', 'conversations');
}

export function resolveConversationPaths(
  conversationId: string,
): HuddleConversationPaths {
  const conversationDir = path.join(resolveConversationRootDir(), conversationId);

  return {
    conversationDir,
    metadataPath: path.join(conversationDir, 'metadata.json'),
    readyPath: path.join(conversationDir, 'ready'),
    closedPath: path.join(conversationDir, 'closed'),
    requestsDir: path.join(conversationDir, 'requests'),
    responsesDir: path.join(conversationDir, 'responses'),
  };
}

export function formatConversationContinueCommand(
  conversationId: string,
): string {
  return `huddle "<message>" -c ${conversationId}`;
}

export function formatConversationContinueInstruction(
  conversationId: string,
): string {
  return `To respond invoke with ${formatConversationContinueCommand(conversationId)}. That conversation_id corresponds to the existing open window.`;
}

export function formatConversationKeepaliveMessage(
  conversationId: string,
): string {
  return `[huddle keepalive] conversation_id=${conversationId}`;
}
