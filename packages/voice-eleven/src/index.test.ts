import { describe, expect, it } from 'vitest';

import { resolveVoiceDescriptor } from './index.js';

describe('resolveVoiceDescriptor', () => {
  const voices = [
    { id: 'voice-1', name: 'Rachel' },
    { id: 'voice-2', name: 'Analyst Pro' },
  ];

  it('matches exact voice ids', () => {
    expect(resolveVoiceDescriptor(voices, 'voice-1')?.id).toBe('voice-1');
  });

  it('matches voice names case-insensitively', () => {
    expect(resolveVoiceDescriptor(voices, 'rachel')?.id).toBe('voice-1');
  });

  it('matches normalized partial names', () => {
    expect(resolveVoiceDescriptor(voices, 'analyst')?.id).toBe('voice-2');
  });

  it('falls back to the first available voice', () => {
    expect(resolveVoiceDescriptor(voices, 'missing')?.id).toBe('voice-1');
  });
});
