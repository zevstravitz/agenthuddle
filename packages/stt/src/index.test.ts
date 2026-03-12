import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpeechTranscriber } from './index.js';

describe('createSpeechTranscriber', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an unavailable transcriber without an API key', () => {
    const transcriber = createSpeechTranscriber(null);

    expect(transcriber.name).toBe('unavailable');
    expect(transcriber.isAvailable()).toBe(false);
  });

  it('uses Groq transcription followed by cleanup', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'huddle-stt-test-'));
    const filePath = path.join(tempDir, 'reply.m4a');
    writeFileSync(filePath, 'audio');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          text: '  make a function called format person name  ',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Make a function called `formatPersonName`.',
              },
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const transcriber = createSpeechTranscriber('test-key');
    const text = await transcriber.transcribeFile({
      filePath,
      transcriptionModel: 'whisper-large-v3-turbo',
      cleanupModel: 'llama-3.1-8b-instant',
      cleanupMode: 'code',
    });

    expect(text).toBe('Make a function called `formatPersonName`.');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [transcribeUrl, transcribeInit] = fetchMock.mock.calls[0] as [
      string,
      {
        method: string;
        headers: Record<string, string>;
        body: FormData;
      },
    ];

    expect(transcribeUrl).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(transcribeInit.method).toBe('POST');
    expect(transcribeInit.headers.Authorization).toBe('Bearer test-key');
    expect(transcribeInit.body.get('model')).toBe('whisper-large-v3-turbo');
    expect(transcribeInit.body.get('response_format')).toBe('json');

    const uploadedFile = transcribeInit.body.get('file');
    expect(uploadedFile).toBeInstanceOf(File);
    expect((uploadedFile as File).name).toBe('recording.m4a');

    const [cleanupUrl, cleanupInit] = fetchMock.mock.calls[1] as [
      string,
      {
        method: string;
        headers: Record<string, string>;
        body: string;
      },
    ];

    expect(cleanupUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(cleanupInit.method).toBe('POST');
    expect(cleanupInit.headers.Authorization).toBe('Bearer test-key');
    expect(cleanupInit.headers['Content-Type']).toBe('application/json');
    expect(cleanupInit.body).toContain('llama-3.1-8b-instant');
    expect(cleanupInit.body).toContain('Clean the transcript inside <transcript></transcript>');

    rmSync(tempDir, { force: true, recursive: true });
  });
});
