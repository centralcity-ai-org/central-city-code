/*
 * Which renderer a room message gets. The server stamps
 * `room_messages.format` ('plain' | 'markdown'; migration 22) and stores new posts as Markdown, so
 * its value decides. A message without a format (an older server or an older row) is plain text.
 * There is no client-side switch.
 */
export type MessageFormat = 'plain' | 'markdown';

/** New posts are stored as Markdown: the composer Preview and a message still being sent. */
export const NEW_POST_FORMAT: MessageFormat = 'markdown';

export function messageFormat(message: { format?: unknown }): MessageFormat {
  return message.format === 'markdown' ? 'markdown' : 'plain';
}

/**
 * Bidirectional controls (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C) make text read
 * differently from what it is ("Trojan Source"); room messages drop them. The Markdown chunk has
 * its own copy (guard.ts), so that chunk does not depend on this one.
 */
export function withoutBidiControls(text: string): string {
  return text.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}
