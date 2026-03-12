export interface PersonaPreset {
  id: string;
  label: string;
  description: string;
  voiceId: string;
}

export interface VoiceConfig {
  defaultVoiceId: string;
  speakingRate: number;
  modelId: string;
  outputFormat: string;
}

export interface VoiceDescriptor {
  id: string;
  name: string;
  category?: string;
  previewUrl?: string;
}

export interface AppConfig {
  voice: VoiceConfig;
  persona: {
    default: string;
    presets: PersonaPreset[];
  };
  apiKeys: {
    groq: string | null;
    elevenLabs: string | null;
  };
}

export const DEFAULT_PERSONAS: PersonaPreset[] = [
  {
    id: 'pair-programmer',
    label: 'Pair Programmer',
    description: 'Balanced default voice behavior for huddles.',
    voiceId: 'analyst',
  },
];

export function nowIso(): string {
  return new Date().toISOString();
}

export function clampText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function addDaysIso(days: number): string {
  const result = new Date();
  result.setDate(result.getDate() + days);
  return result.toISOString();
}
