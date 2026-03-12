import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfig } from './index.js';

const tempDirs: string[] = [];

describe('resolveConfig', () => {
  afterEach(() => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_TOKEN;

    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses huddle defaults when no config file exists', () => {
    const cwd = createTempDir();
    const { config, configPath } = resolveConfig({ cwd });

    expect(configPath).toBeNull();
    expect(config.voice.defaultVoiceId).toBe('analyst');
    expect(config.voice.modelId).toBe('eleven_multilingual_v2');
    expect(config.persona.default).toBe('pair-programmer');
    expect(config.apiKeys.groq).toBeNull();
    expect(config.apiKeys.elevenLabs).toBeNull();
  });

  it('merges local config file values', () => {
    const cwd = createTempDir();
    writeFileSync(
      path.join(cwd, 'huddle.config.json'),
      JSON.stringify(
        {
          voice: { defaultVoiceId: 'Custom Voice', speakingRate: 1.1 },
          persona: {
            default: 'custom',
            presets: [
              {
                id: 'custom',
                label: 'Custom',
                description: 'Test',
                voiceId: 'Custom Voice',
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const { config, configPath } = resolveConfig({ cwd });

    expect(configPath).toContain('huddle.config.json');
    expect(config.voice.defaultVoiceId).toBe('Custom Voice');
    expect(config.voice.speakingRate).toBe(1.1);
    expect(config.persona.default).toBe('custom');
    expect(
      config.persona.presets.find((preset) => preset.id === 'custom')?.voiceId,
    ).toBe('Custom Voice');
  });

  it('loads api keys from .env in the working directory', () => {
    const cwd = createTempDir();
    writeFileSync(
      path.join(cwd, '.env'),
      'GROK_API_KEY=dotenv-groq\nELEVENLABS_TOKEN=dotenv-eleven\n',
    );

    const { config } = resolveConfig({ cwd });

    expect(config.apiKeys.groq).toBe('dotenv-groq');
    expect(config.apiKeys.elevenLabs).toBe('dotenv-eleven');
  });

  it('keeps shell environment precedence over .env files', () => {
    const cwd = createTempDir();
    writeFileSync(path.join(cwd, '.env'), 'ELEVENLABS_API_KEY=dotenv-eleven\n');
    process.env.ELEVENLABS_API_KEY = 'shell-eleven';

    const { config } = resolveConfig({ cwd });

    expect(config.apiKeys.elevenLabs).toBe('shell-eleven');
  });

  it('accepts legacy shell aliases for local tokens', () => {
    const cwd = createTempDir();
    process.env.GROK_API_KEY = 'shell-groq';
    process.env.ELEVENLABS_TOKEN = 'shell-eleven';

    const { config } = resolveConfig({ cwd });

    expect(config.apiKeys.groq).toBe('shell-groq');
    expect(config.apiKeys.elevenLabs).toBe('shell-eleven');
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'huddle-config-'));
  tempDirs.push(dir);
  return dir;
}
