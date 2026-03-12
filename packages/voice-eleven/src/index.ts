import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import type { Logger } from '@huddle/logger';
import type { VoiceConfig, VoiceDescriptor } from '@huddle/shared';

export interface VoiceRenderer {
  isAvailable(): boolean;
  listVoices(): Promise<VoiceDescriptor[]>;
  speak(text: string, options: SpeakOptions): Promise<void>;
  stop(): void;
}

export interface SpeakOptions {
  voiceId: string;
  speed?: number;
}

export class SilentVoiceRenderer implements VoiceRenderer {
  isAvailable(): boolean {
    return false;
  }

  async listVoices(): Promise<VoiceDescriptor[]> {
    return [];
  }

  async speak(): Promise<void> {}

  stop(): void {}
}

export class ElevenLabsVoiceRenderer implements VoiceRenderer {
  private activePlayer: ChildProcess | null = null;
  private activeTempFile: string | null = null;
  private voiceCache: Promise<VoiceDescriptor[]> | null = null;
  private playbackQueue: Promise<void> = Promise.resolve();
  private stopToken = 0;

  constructor(
    private readonly apiKey: string,
    private readonly config: VoiceConfig,
    private readonly logger: Logger,
  ) {}

  isAvailable(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async listVoices(): Promise<VoiceDescriptor[]> {
    if (!this.voiceCache) {
      this.voiceCache = this.fetchVoices();
    }

    return this.voiceCache;
  }

  async fetchVoices(): Promise<VoiceDescriptor[]> {
    return listVoicesWithElevenLabs(this.apiKey);
  }

  async speak(text: string, options: SpeakOptions): Promise<void> {
    if (!this.isAvailable() || text.trim().length === 0) {
      return;
    }

    const token = this.stopToken;
    this.playbackQueue = this.playbackQueue
      .catch(() => undefined)
      .then(() => this.performSpeak(text, options, token));

    await this.playbackQueue;
  }

  stop(): void {
    this.stopToken += 1;

    if (this.activePlayer) {
      this.activePlayer.kill('SIGTERM');
      this.activePlayer = null;
    }

    if (this.activeTempFile) {
      void cleanupTempFile(this.activeTempFile);
      this.activeTempFile = null;
    }
  }

  private async performSpeak(text: string, options: SpeakOptions, token: number): Promise<void> {
    if (token !== this.stopToken) {
      return;
    }

    const voices = await this.listVoices();
    if (token !== this.stopToken) {
      return;
    }

    const resolvedVoice = resolveVoiceDescriptor(voices, options.voiceId);

    if (!resolvedVoice) {
      throw new Error('No ElevenLabs voices are available for this account.');
    }

    if (resolvedVoice.id !== options.voiceId) {
      this.logger.warn('configured ElevenLabs voice was not found; falling back', {
        requestedVoiceId: options.voiceId,
        resolvedVoiceId: resolvedVoice.id,
        resolvedVoiceName: resolvedVoice.name,
      });
    }

    const audioBuffer = await synthesizeSpeechWithElevenLabs({
      apiKey: this.apiKey,
      config: this.config,
      text,
      voiceId: resolvedVoice.id,
      ...(typeof options.speed === 'number' ? { speed: options.speed } : {}),
    });
    if (token !== this.stopToken) {
      return;
    }

    const tempFile = path.join(tmpdir(), `huddle-${randomUUID()}.mp3`);
    await writeFile(tempFile, audioBuffer);

    if (token !== this.stopToken) {
      await cleanupTempFile(tempFile);
      return;
    }

    this.activeTempFile = tempFile;

    await new Promise<void>((resolve, reject) => {
      const player = spawn('afplay', [tempFile], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      this.activePlayer = player;
      let stderr = '';

      player.stderr?.setEncoding('utf8');
      player.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });

      player.once('error', reject);
      player.once('close', (code) => {
        this.activePlayer = null;
        void cleanupTempFile(tempFile);
        this.activeTempFile = null;

        if (code === 0 || code === null || token !== this.stopToken) {
          resolve();
          return;
        }

        reject(new Error(stderr || `afplay exited with code ${code}`));
      });
    }).catch((error: unknown) => {
      this.logger.warn('voice playback failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export function createVoiceRenderer(
  apiKey: string | null,
  config: VoiceConfig,
  logger: Logger,
): VoiceRenderer {
  if (!apiKey) {
    return new SilentVoiceRenderer();
  }

  return new ElevenLabsVoiceRenderer(apiKey, config, logger);
}

export async function listVoicesWithElevenLabs(apiKey: string): Promise<VoiceDescriptor[]> {
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: {
      'xi-api-key': apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list ElevenLabs voices: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    voices?: Array<{
      voice_id?: string;
      name?: string;
      category?: string;
      preview_url?: string;
    }>;
  };

  return (payload.voices ?? [])
    .filter((voice): voice is Required<Pick<typeof voice, 'voice_id' | 'name'>> & typeof voice =>
      Boolean(voice.voice_id && voice.name),
    )
    .map((voice) => ({
      id: voice.voice_id,
      name: voice.name,
      ...(voice.category ? { category: voice.category } : {}),
      ...(voice.preview_url ? { previewUrl: voice.preview_url } : {}),
    }));
}

export async function synthesizeSpeechWithElevenLabs(input: {
  apiKey: string;
  config: VoiceConfig;
  text: string;
  voiceId: string;
  speed?: number;
}): Promise<Buffer> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/stream`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': input.apiKey,
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: input.text,
        model_id: input.config.modelId,
        voice_settings: {
          speed: input.speed ?? input.config.speakingRate,
        },
        output_format: input.config.outputFormat,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to synthesize speech: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function cleanupTempFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined);
}

export function resolveVoiceDescriptor(
  voices: VoiceDescriptor[],
  requestedVoiceId: string,
): VoiceDescriptor | null {
  if (voices.length === 0) {
    return null;
  }

  const exactId = voices.find((voice) => voice.id === requestedVoiceId);
  if (exactId) {
    return exactId;
  }

  const normalizedRequest = normalizeVoiceToken(requestedVoiceId);
  const exactName = voices.find((voice) => normalizeVoiceToken(voice.name) === normalizedRequest);
  if (exactName) {
    return exactName;
  }

  const partialName = voices.find((voice) => {
    const normalizedName = normalizeVoiceToken(voice.name);
    return normalizedName.includes(normalizedRequest) || normalizedRequest.includes(normalizedName);
  });
  if (partialName) {
    return partialName;
  }

  return voices[0] ?? null;
}

function normalizeVoiceToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
