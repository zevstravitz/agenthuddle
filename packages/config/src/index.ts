import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { parse } from 'dotenv';
import { z } from 'zod';

import {
  type AppConfig,
  DEFAULT_PERSONAS,
  type PersonaPreset,
} from '@huddle/shared';

const personaPresetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  voiceId: z.string().min(1),
});

const fileConfigSchema = z.object({
  voice: z
    .object({
      defaultVoiceId: z.string().min(1).optional(),
      speakingRate: z.number().positive().optional(),
      modelId: z.string().min(1).optional(),
      outputFormat: z.string().min(1).optional(),
    })
    .optional(),
  persona: z
    .object({
      default: z.string().min(1).optional(),
      presets: z.array(personaPresetSchema).optional(),
    })
    .optional(),
});

const DEFAULT_CONFIG_DIR = path.join(homedir(), '.huddle');

export interface ResolveConfigOptions {
  cwd?: string;
  explicitConfigPath?: string;
}

export function resolveConfig(options: ResolveConfigOptions = {}): {
  config: AppConfig;
  configPath: string | null;
} {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  loadDotenvFiles(cwd);
  const configPath = resolveConfigPath(cwd, options.explicitConfigPath);
  const fileConfig = loadFileConfig(configPath);

  return {
    config: {
      voice: {
        defaultVoiceId: fileConfig?.voice?.defaultVoiceId ?? 'analyst',
        speakingRate: fileConfig?.voice?.speakingRate ?? 1.1,
        modelId: fileConfig?.voice?.modelId ?? 'eleven_multilingual_v2',
        outputFormat: fileConfig?.voice?.outputFormat ?? 'mp3_44100_128',
      },
      persona: {
        default: fileConfig?.persona?.default ?? 'pair-programmer',
        presets: mergePersonas(fileConfig?.persona?.presets),
      },
      apiKeys: {
        groq: readEnvAny(['GROQ_API_KEY', 'GROK_API_KEY']),
        elevenLabs: readEnvAny(['ELEVENLABS_API_KEY', 'ELEVENLABS_TOKEN']),
      },
    },
    configPath,
  };
}

export function resolvePersonaPreset(
  config: AppConfig,
  personaId: string,
): PersonaPreset {
  return (
    config.persona.presets.find((preset) => preset.id === personaId) ??
    config.persona.presets.find(
      (preset) => preset.id === config.persona.default,
    ) ??
    DEFAULT_PERSONAS[0]!
  );
}

function mergePersonas(
  overrides: PersonaPreset[] | undefined,
): PersonaPreset[] {
  if (!overrides || overrides.length === 0) {
    return DEFAULT_PERSONAS;
  }

  const presets = new Map(
    DEFAULT_PERSONAS.map((preset) => [preset.id, preset]),
  );
  for (const preset of overrides) {
    presets.set(preset.id, preset);
  }

  return [...presets.values()];
}

function readEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : null;
}

function readEnvAny(names: string[]): string | null {
  for (const name of names) {
    const value = readEnv(name);
    if (value) {
      return value;
    }
  }

  return null;
}

function resolveConfigPath(
  cwd: string,
  explicitConfigPath?: string,
): string | null {
  const candidates = explicitConfigPath
    ? [path.resolve(explicitConfigPath)]
    : [
        path.join(cwd, 'huddle.config.json'),
        path.join(cwd, '.huddle.json'),
        path.join(cwd, 'agent-voice.config.json'),
        path.join(cwd, '.agent-voice.json'),
        path.join(DEFAULT_CONFIG_DIR, 'config.json'),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function loadFileConfig(
  configPath: string | null,
): z.infer<typeof fileConfigSchema> | undefined {
  if (!configPath) {
    return undefined;
  }

  const raw = readFileSync(configPath, 'utf8');
  return fileConfigSchema.parse(JSON.parse(raw) as unknown);
}

function loadDotenvFiles(cwd: string): void {
  const originalEnvKeys = new Set(Object.keys(process.env));
  const candidates = [path.join(cwd, '.env'), path.join(cwd, '.env.local')];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const parsed = parse(readFileSync(candidate, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (originalEnvKeys.has(key)) {
        continue;
      }

      process.env[key] = value;
    }
  }
}
