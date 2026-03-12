#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { Command } from 'commander';

import { resolveConfig, resolvePersonaPreset } from '@huddle/config';
import { createLogger } from '@huddle/logger';
import {
  clampText,
  normalizeWhitespace,
  nowIso,
  type AppConfig,
} from '@huddle/shared';
import {
  createSpeechTranscriber,
  type CleanupModeId,
} from '@huddle/stt';
import { createVoiceRenderer } from '@huddle/voice-eleven';

import {
  createConversationId,
  formatConversationContinueCommand,
  formatConversationContinueInstruction,
  resolveConversationPaths,
  type HuddleConversationMetadata,
  type HuddleConversationPaths,
} from './conversations.js';

const program = new Command();
const DEFAULT_MAX_SECONDS = 90;
const DEFAULT_HUDDLE_SPEECH_SPEED = 1.12;
const HUDDLE_DECLINED = '[huddle declined]';
const HUDDLE_CANCELLED = '[huddle cancelled]';
const HUDDLE_MISSED = '[huddle missed]';

type HuddleUiMode =
  | 'invite'
  | 'speaking'
  | 'record'
  | 'transcribing'
  | 'review'
  | 'close'
  | 'terminate';

interface CredentialOptions {
  groqApiKey?: string;
  grokToken?: string;
  elevenlabsApiKey?: string;
  elevenlabsToken?: string;
}

interface HuddleCommandOptions extends CredentialOptions {
  title?: string;
  maxSeconds?: number;
  conversation?: string;
  json?: boolean;
  voice?: string;
}

interface StatusCommandOptions extends CredentialOptions {
  json?: boolean;
  voice?: string;
}

interface ResolvedCredentials {
  groqApiKey: string | null;
  elevenLabsApiKey: string | null;
}

interface HuddleUiRequest {
  mode: HuddleUiMode;
  title: string;
  promptPreview: string;
  ringSoundPath?: string;
  recordingPath?: string;
  maxRecordingSeconds?: number;
  transcriptText?: string;
}

interface HuddleUiResult {
  requestId: string;
  mode: 'invite' | 'speaking' | 'record' | 'review' | 'close';
  status: 'accepted' | 'declined' | 'cancelled' | 'missed' | 'kept_open';
  audioPath?: string;
  transcriptText?: string;
  keepConversationOpen?: boolean;
  submitTranscriptDirectly?: boolean;
}

interface HuddleLogEntry {
  createdAt: string;
  conversationId?: string;
  cwd: string;
  keepConversationOpen?: boolean;
  prompt: string;
  status: HuddleUiResult['status'];
  response?: string;
}

const shouldPersistHuddleLogs = resolveShouldPersistHuddleLogs();

program
  .name('huddle')
  .description(
    'Open a local spoken huddle so Codex can get a short voice clarification from you.',
  )
  .argument('[message...]', 'question or clarification to ask out loud')
  .option('--title <title>', 'popup title', 'Codex Huddle')
  .option('--max-seconds <seconds>', 'maximum recording length', parseInteger)
  .option(
    '-c, --conversation <id>',
    'reuse an existing open conversation window',
  )
  .option('--voice <id>', 'override the ElevenLabs voice id for this run')
  .option('--groq-api-key <token>', 'Groq API key for transcription')
  .option(
    '--grok-token <token>',
    'alias for --groq-api-key for compatibility with existing local scripts',
  )
  .option(
    '--elevenlabs-api-key <token>',
    'ElevenLabs API key for spoken prompt playback',
  )
  .option(
    '--elevenlabs-token <token>',
    'alias for --elevenlabs-api-key',
  )
  .option('--json', 'print a JSON result instead of plain text')
  .action(async (messageParts: string[], options: HuddleCommandOptions) => {
    if (messageParts.length === 0) {
      program.outputHelp();
      return;
    }

    await runHuddleCommand(messageParts.join(' '), options);
  });

program
  .command('status')
  .description('Show local token and dependency readiness for this CLI.')
  .option('--voice <id>', 'override the resolved voice id for this status check')
  .option('--groq-api-key <token>', 'Groq API key for transcription')
  .option(
    '--grok-token <token>',
    'alias for --groq-api-key for compatibility with existing local scripts',
  )
  .option(
    '--elevenlabs-api-key <token>',
    'ElevenLabs API key for spoken prompt playback',
  )
  .option(
    '--elevenlabs-token <token>',
    'alias for --elevenlabs-api-key',
  )
  .option('--json', 'print a JSON result instead of plain text')
  .action(async (options: StatusCommandOptions) => {
    await runStatusCommand(options);
  });

program
  .command('close')
  .description('Close an existing open huddle conversation window.')
  .option('-c, --conversation <id>', 'conversation id for the open window to close')
  .option('--json', 'print a JSON result instead of plain text')
  .action(async (options) => {
    await runCloseCommand({
      conversation: options.conversation as string,
      json: options.json as boolean,
    });
  });

async function runHuddleCommand(
  rawMessage: string,
  options: HuddleCommandOptions,
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('The huddle command currently requires macOS.');
  }

  ensureSwiftAvailable();

  const prompt = clampText(normalizeWhitespace(rawMessage), 700);
  if (!prompt) {
    return;
  }

  const cwd = process.cwd();
  const { config } = resolveConfig({ cwd });
  const credentials = resolveCredentials(config, options);
  if (!credentials.groqApiKey) {
    throw new Error(
      'Groq transcription is not configured. Pass --groq-api-key or set GROQ_API_KEY.',
    );
  }

  const persona = resolvePersonaPreset(config, config.persona.default);
  const voiceId =
    options.voice ??
    process.env.HUDDLE_VOICE ??
    persona.voiceId ??
    config.voice.defaultVoiceId;
  const speechSpeed = resolveHuddleSpeechSpeed(
    process.env.HUDDLE_SPEECH_SPEED,
  );
  const logger = createLogger({
    name: 'huddle',
  });
  const transcriber = createSpeechTranscriber(credentials.groqApiKey);
  const voiceRenderer = createVoiceRenderer(
    credentials.elevenLabsApiKey,
    config.voice,
    logger,
  );
  const tempDir = mkdtempSync(path.join(tmpdir(), 'huddle-'));
  const recordingPath = path.join(tempDir, 'response.m4a');
  const ringSoundPath = resolveRingSoundPath(cwd);
  const title = options.title ?? 'Codex Huddle';
  const ui = options.conversation
    ? connectToHuddleUiSession(options.conversation)
    : await startHuddleUiSession({ cwd, title });
  let shouldKeepConversationOpen = false;

  try {
    if (!ui.isContinuation) {
      const inviteResult = await ui.request({
        mode: 'invite',
        title,
        promptPreview: clampText(prompt, 240),
        ...(ringSoundPath ? { ringSoundPath } : {}),
      });

      if (inviteResult.status !== 'accepted') {
        const entry: HuddleLogEntry = {
          createdAt: nowIso(),
          conversationId: ui.conversationId,
          cwd,
          prompt,
          status: inviteResult.status,
        };
        appendHuddleLog(entry);
        writeResult({
          json: options.json ?? false,
          status: inviteResult.status,
        });
        return;
      }
    }

    const speakingSkip = ui.send({
      mode: 'speaking',
      title,
      promptPreview: clampText(prompt, 280),
    });
    try {
      const outcome = await Promise.race([
        voiceRenderer.speak(prompt, {
          speed: speechSpeed,
          voiceId,
        }).then(() => 'completed' as const),
        speakingSkip.result.then((result) =>
          result?.status === 'accepted' ? ('skipped' as const) : 'completed',
        ),
      ]);

      if (outcome === 'skipped') {
        voiceRenderer.stop();
      }
    } catch {
      // Continue without spoken playback if local speech synthesis fails.
    } finally {
      speakingSkip.cancel();
      voiceRenderer.stop();
    }

    const recordResult = await ui.request({
      mode: 'record',
      title,
      promptPreview: clampText(prompt, 320),
      recordingPath,
      maxRecordingSeconds: options.maxSeconds ?? DEFAULT_MAX_SECONDS,
    });

    if (recordResult.status !== 'accepted') {
      const entry: HuddleLogEntry = {
        createdAt: nowIso(),
        conversationId: ui.conversationId,
        cwd,
        prompt,
        status: recordResult.status,
      };
      appendHuddleLog(entry);
      writeResult({
        json: options.json ?? false,
        status: recordResult.status,
      });
      return;
    }

    ui.notify({
      mode: 'transcribing',
      title,
      promptPreview: recordResult.submitTranscriptDirectly
        ? 'Transcribing your answer and sending it right away.'
        : 'Turning your answer into text for a quick final review.',
    });

    const transcript = await transcriber.transcribeFile({
      filePath: recordResult.audioPath ?? recordingPath,
      ...(process.env.HUDDLE_TRANSCRIBE_MODEL
        ? { transcriptionModel: process.env.HUDDLE_TRANSCRIBE_MODEL }
        : {}),
      ...(process.env.HUDDLE_CLEANUP_MODEL
        ? { cleanupModel: process.env.HUDDLE_CLEANUP_MODEL }
        : {}),
      ...(process.env.HUDDLE_CLEANUP_MODE
        ? {
            cleanupMode: process.env.HUDDLE_CLEANUP_MODE as CleanupModeId,
          }
        : {}),
    });

    if (recordResult.submitTranscriptDirectly) {
      const entry: HuddleLogEntry = {
        createdAt: nowIso(),
        cwd,
        keepConversationOpen: false,
        prompt,
        status: 'accepted',
        response: transcript,
      };
      appendHuddleLog(entry);

      writeResult({
        json: options.json ?? false,
        status: 'accepted',
        keepConversationOpen: false,
        response: transcript,
      });
      return;
    }

    const reviewResult = await ui.request({
      mode: 'review',
      title,
      promptPreview: clampText(prompt, 320),
      transcriptText: transcript,
    });

    if (reviewResult.status !== 'accepted') {
      const entry: HuddleLogEntry = {
        createdAt: nowIso(),
        conversationId: ui.conversationId,
        cwd,
        prompt,
        status: reviewResult.status,
      };
      appendHuddleLog(entry);
      writeResult({
        json: options.json ?? false,
        status: reviewResult.status,
      });
      return;
    }

    const reviewedTranscript = (
      reviewResult.transcriptText ?? transcript
    ).trim();
    shouldKeepConversationOpen = reviewResult.keepConversationOpen ?? false;

    const entry: HuddleLogEntry = {
      createdAt: nowIso(),
      cwd,
      keepConversationOpen: shouldKeepConversationOpen,
      prompt,
      status: 'accepted',
      response: reviewedTranscript,
      ...(shouldKeepConversationOpen
        ? { conversationId: ui.conversationId }
        : {}),
    };
    appendHuddleLog(entry);

    writeResult({
      json: options.json ?? false,
      status: 'accepted',
      keepConversationOpen: shouldKeepConversationOpen,
      response: reviewedTranscript,
      ...(shouldKeepConversationOpen
        ? { conversationId: ui.conversationId }
        : {}),
    });
  } finally {
    if (shouldKeepConversationOpen) {
      ui.detach();
    } else {
      await ui.terminate();
      cleanupConversation(ui.paths);
    }
    voiceRenderer.stop();
    rmSync(tempDir, { force: true, recursive: true });
  }
}

async function runStatusCommand(options: StatusCommandOptions): Promise<void> {
  const cwd = process.cwd();
  const { config } = resolveConfig({ cwd });
  const credentials = resolveCredentials(config, options);
  const persona = resolvePersonaPreset(config, config.persona.default);
  const voiceId =
    options.voice ??
    process.env.HUDDLE_VOICE ??
    persona.voiceId ??
    config.voice.defaultVoiceId;
  const swiftAvailable = canRunSwift();
  const output = {
    mode: 'local',
    platform: process.platform,
    swiftAvailable,
    groqConfigured: Boolean(credentials.groqApiKey),
    elevenLabsConfigured: Boolean(credentials.elevenLabsApiKey),
    defaultPersona: config.persona.default,
    defaultVoiceId: voiceId,
    speechSpeed: resolveHuddleSpeechSpeed(process.env.HUDDLE_SPEECH_SPEED),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.stdout.write('Mode: local-only\n');
  process.stdout.write(`Platform: ${output.platform}\n`);
  process.stdout.write(`Swift available: ${output.swiftAvailable ? 'yes' : 'no'}\n`);
  process.stdout.write(
    `Groq transcription: ${output.groqConfigured ? 'configured' : 'not configured'}\n`,
  );
  process.stdout.write(
    `ElevenLabs speech: ${output.elevenLabsConfigured ? 'configured' : 'not configured'}\n`,
  );
  process.stdout.write(`Default persona: ${output.defaultPersona}\n`);
  process.stdout.write(`Default voice: ${output.defaultVoiceId}\n`);
  process.stdout.write(`Speech speed: ${output.speechSpeed}\n`);

  if (!output.groqConfigured) {
    process.stdout.write(
      'Pass --groq-api-key or set GROQ_API_KEY before recording a huddle.\n',
    );
  }

  if (!output.elevenLabsConfigured) {
    process.stdout.write(
      'Pass --elevenlabs-api-key or set ELEVENLABS_API_KEY to hear spoken prompts.\n',
    );
  }
}

async function runCloseCommand(options: {
  conversation: string;
  json: boolean;
}): Promise<void> {
  const normalizedConversationId = normalizeWhitespace(options.conversation);
  if (!normalizedConversationId) {
    throw new Error('A conversation id is required with `-c`.');
  }

  const paths = resolveConversationPaths(normalizedConversationId);
  const metadata = readConversationMetadata(paths);

  if (!metadata || !isConversationAvailable(paths, metadata.pid)) {
    cleanupConversation(paths);
    writeCloseResult({
      json: options.json,
      conversationId: normalizedConversationId,
      status: 'already_closed',
    });
    return;
  }

  const ui = new HuddleUiSession({
    conversationId: metadata.conversationId,
    isContinuation: true,
    paths,
  });
  const status = await ui.requestCloseApproval();
  if (status === 'closed') {
    cleanupConversation(paths);
  }
  writeCloseResult({
    json: options.json,
    conversationId: metadata.conversationId,
    status,
  });
}

async function maybeRunDirectCloseCommand(argv: string[]): Promise<boolean> {
  if (argv[2] !== 'close') {
    return false;
  }

  let conversation = '';
  let json = false;

  for (let index = 3; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) {
      continue;
    }

    if (argument === '--json') {
      json = true;
      continue;
    }

    if (argument === '-c' || argument === '--conversation') {
      conversation = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
  }

  await runCloseCommand({
    conversation,
    json,
  });
  return true;
}

async function startHuddleUiSession(input: {
  cwd: string;
  title: string;
}): Promise<HuddleUiSession> {
  const conversationId = createConversationId();
  const paths = resolveConversationPaths(conversationId);
  cleanupConversation(paths);
  mkdirSync(paths.requestsDir, { recursive: true });
  mkdirSync(paths.responsesDir, { recursive: true });

  const launchSpec = resolveHuddleUiLaunchSpec({
    conversationId,
    conversationDir: paths.conversationDir,
  });
  const child = spawn(launchSpec.command, launchSpec.args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  writeConversationMetadata(paths, {
    conversationId,
    conversationDir: paths.conversationDir,
    createdAt: nowIso(),
    cwd: input.cwd,
    pid: child.pid ?? null,
    title: input.title,
  });

  try {
    await waitForConversationReady(paths, child.pid ?? null);
  } catch (error) {
    cleanupConversation(paths);
    if (child.pid) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Ignore stale startup processes.
      }
    }
    throw error;
  }

  return new HuddleUiSession({
    conversationId,
    isContinuation: false,
    paths,
  });
}

function connectToHuddleUiSession(conversationId: string): HuddleUiSession {
  const normalizedConversationId = normalizeWhitespace(conversationId);
  if (!normalizedConversationId) {
    throw new Error('A conversation id is required with `-c`.');
  }

  const paths = resolveConversationPaths(normalizedConversationId);
  const metadata = readConversationMetadata(paths);

  if (!metadata) {
    throw new Error(
      `No open huddle conversation exists for "${normalizedConversationId}".`,
    );
  }

  if (!isConversationAvailable(paths, metadata.pid)) {
    cleanupConversation(paths);
    throw new Error(
      `The huddle conversation "${normalizedConversationId}" is no longer available.`,
    );
  }

  return new HuddleUiSession({
    conversationId: metadata.conversationId,
    isContinuation: true,
    paths,
  });
}

function resolveHuddleUiLaunchSpec(input: {
  conversationDir: string;
  conversationId: string;
}): {
  command: string;
  args: string[];
} {
  const helperPath = resolveHuddleUiBinaryPath();
  if (helperPath) {
    return {
      command: helperPath,
      args: [
        '--conversation-id',
        input.conversationId,
        '--conversation-dir',
        input.conversationDir,
      ],
    };
  }

  ensureSwiftAvailable();

  return {
    command: 'swift',
    args: [
      resolveHuddleUiScriptPath(),
      '--conversation-id',
      input.conversationId,
      '--conversation-dir',
      input.conversationDir,
    ],
  };
}

class PendingHuddleUiRequest {
  constructor(
    readonly requestId: string,
    readonly result: Promise<HuddleUiResult | null>,
    private readonly cancelWait: () => void,
  ) {}

  cancel(): void {
    this.cancelWait();
  }
}

class HuddleUiSession {
  private detached = false;

  readonly conversationId: string;
  readonly isContinuation: boolean;
  readonly paths: HuddleConversationPaths;

  constructor(input: {
    conversationId: string;
    isContinuation: boolean;
    paths: HuddleConversationPaths;
  }) {
    this.conversationId = input.conversationId;
    this.isContinuation = input.isContinuation;
    this.paths = input.paths;
  }

  notify(command: HuddleUiRequest): void {
    this.writeRequest(command);
  }

  send(command: HuddleUiRequest): PendingHuddleUiRequest {
    const requestId = this.writeRequest(command);
    const responsePath = path.join(this.paths.responsesDir, `${requestId}.json`);

    let cancelled = false;
    const result = (async (): Promise<HuddleUiResult | null> => {
      while (true) {
        if (cancelled) {
          return null;
        }

        if (existsSync(responsePath)) {
          const parsed = JSON.parse(
            readFileSync(responsePath, 'utf8'),
          ) as HuddleUiResult;
          rmSync(responsePath, { force: true });
          return this.validateResponse(parsed);
        }

        if (existsSync(this.paths.closedPath)) {
          return null;
        }

        await sleep(80);
      }
    })();

    return new PendingHuddleUiRequest(requestId, result, () => {
      cancelled = true;
      rmSync(responsePath, { force: true });
    });
  }

  private writeRequest(command: HuddleUiRequest): string {
    this.ensureAvailable();
    mkdirSync(this.paths.requestsDir, { recursive: true });
    mkdirSync(this.paths.responsesDir, { recursive: true });

    const requestId = createRequestId();
    const requestPath = path.join(this.paths.requestsDir, `${requestId}.json`);
    writeFileSync(
      requestPath,
      `${JSON.stringify({
        requestId,
        ...command,
      })}\n`,
    );
    return requestId;
  }

  async request(command: HuddleUiRequest): Promise<HuddleUiResult> {
    const pending = this.send(command);
    const response = await pending.result;
    if (!response) {
      throw new Error('The huddle UI is not available.');
    }

    return response;
  }

  async requestCloseApproval(): Promise<'closed' | 'kept_open' | 'already_closed'> {
    if (this.detached || !existsSync(this.paths.readyPath)) {
      return 'already_closed';
    }

    let response: HuddleUiResult;
    try {
      response = await this.request({
        mode: 'close',
        title: 'Close huddle?',
        promptPreview: 'Codex asked to close this huddle conversation.',
      });
    } catch {
      return 'already_closed';
    }

    if (response.status !== 'accepted') {
      return 'kept_open';
    }

    await this.waitForClosed(1500);
    return 'closed';
  }

  async terminate(): Promise<void> {
    if (this.detached || !existsSync(this.paths.readyPath)) {
      return;
    }

    try {
      this.notify({
        mode: 'terminate',
        title: '',
        promptPreview: '',
      });
    } catch {
      return;
    }

    await this.waitForClosed(1500);
  }

  private async waitForClosed(timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (existsSync(this.paths.closedPath) || !existsSync(this.paths.readyPath)) {
        return;
      }

      await sleep(80);
    }
  }

  detach(): void {
    this.detached = true;
  }

  private ensureAvailable(): void {
    if (!existsSync(this.paths.readyPath) || existsSync(this.paths.closedPath)) {
      throw new Error('The huddle UI is not available.');
    }
  }

  private validateResponse(response: HuddleUiResult): HuddleUiResult {
    if (response.mode === 'record' && response.status === 'accepted') {
      const audioPath = response.audioPath;
      if (!audioPath || !waitForAudioFile(audioPath, 4000)) {
        throw new Error('The huddle recording completed without an audio file.');
      }
    }

    return response;
  }
}

function writeConversationMetadata(
  paths: HuddleConversationPaths,
  metadata: HuddleConversationMetadata,
): void {
  mkdirSync(paths.conversationDir, { recursive: true });
  writeFileSync(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

function readConversationMetadata(
  paths: HuddleConversationPaths,
): HuddleConversationMetadata | null {
  if (!existsSync(paths.metadataPath)) {
    return null;
  }

  try {
    return JSON.parse(
      readFileSync(paths.metadataPath, 'utf8'),
    ) as HuddleConversationMetadata;
  } catch {
    return null;
  }
}

function cleanupConversation(paths: HuddleConversationPaths): void {
  rmSync(paths.conversationDir, { force: true, recursive: true });
}

function isConversationAvailable(
  paths: HuddleConversationPaths,
  pid: number | null,
): boolean {
  if (existsSync(paths.closedPath) || !existsSync(paths.readyPath)) {
    return false;
  }

  if (pid === null) {
    return true;
  }

  return isProcessRunning(pid);
}

async function waitForConversationReady(
  paths: HuddleConversationPaths,
  pid: number | null,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    if (existsSync(paths.readyPath)) {
      return;
    }

    if (existsSync(paths.closedPath) || (pid !== null && !isProcessRunning(pid))) {
      throw new Error('The huddle UI closed before it became ready.');
    }

    await sleep(80);
  }

  throw new Error('Timed out while waiting for the huddle UI to open.');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createRequestId(): string {
  return `${Date.now().toString(36)}-${createConversationId()}`;
}

function resolveHuddleUiScriptPath(): string {
  const candidates = resolveBundledAssetCandidates('huddle-ui.swift');

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Could not locate huddle-ui.swift.');
}

function resolveHuddleUiBinaryPath(): string | null {
  const candidates = resolveBundledAssetCandidates('bin/huddle-ui');

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function waitForAudioFile(filePath: string, timeoutMs: number): boolean {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(filePath)) {
      try {
        const stats = statSync(filePath);
        if (stats.size > 0) {
          return true;
        }
      } catch {
        // Keep polling until timeout.
      }
    }

    spawnSync('sleep', ['0.1']);
  }

  return false;
}

function resolveRingSoundPath(cwd: string): string | null {
  const envPath = process.env.HUDDLE_RING_PATH;
  const candidates = [
    envPath ? path.resolve(cwd, envPath) : null,
    ...resolveBundledAssetCandidates('assets/huddle-ring.mp3'),
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveBundledAssetCandidates(relativePath: string): string[] {
  const baseDir = path.dirname(resolveModuleFilePath());
  return [
    path.join(baseDir, relativePath),
    path.join(baseDir, '..', relativePath),
    path.join(baseDir, '..', '..', '..', relativePath),
  ];
}

function resolveModuleFilePath(): string {
  const entryPath = process.argv[1];
  if (entryPath) {
    return path.resolve(entryPath);
  }

  throw new Error('Could not resolve the current huddle CLI path.');
}

function appendHuddleLog(entry: HuddleLogEntry): void {
  if (!shouldPersistHuddleLogs) {
    return;
  }

  const logDir = path.join(entry.cwd, '.huddle');
  mkdirSync(logDir, { recursive: true });
  appendFileSync(
    path.join(logDir, 'huddles.log'),
    `${JSON.stringify(entry)}\n`,
  );
}

function resolveShouldPersistHuddleLogs(): boolean {
  if (process.env.NODE_ENV === 'development') {
    return true;
  }

  const modulePath = resolveModuleFilePath();
  const normalizedModulePath = modulePath.split(path.sep).join('/');
  return normalizedModulePath.endsWith('/src/huddle.ts');
}

function writeResult(input: {
  json: boolean;
  status: HuddleUiResult['status'];
  conversationId?: string;
  keepConversationOpen?: boolean;
  response?: string;
}): void {
  if (input.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: input.status,
          ...(input.response ? { response: input.response } : {}),
          ...(input.conversationId
            ? {
                continueCommand: formatConversationContinueCommand(
                  input.conversationId,
                ),
                conversationId: input.conversationId,
              }
            : {}),
          ...(input.keepConversationOpen
            ? { keepConversationOpen: true }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (input.status === 'declined') {
    process.stdout.write(`${HUDDLE_DECLINED}\n`);
    return;
  }

  if (input.status === 'cancelled') {
    process.stdout.write(`${HUDDLE_CANCELLED}\n`);
    return;
  }

  if (input.status === 'missed') {
    process.stdout.write(`${HUDDLE_MISSED}\n`);
    return;
  }

  process.stdout.write(`${input.response ?? ''}\n`);

  if (input.keepConversationOpen && input.conversationId) {
    process.stdout.write(
      `${formatConversationContinueInstruction(input.conversationId)}\n`,
    );
  }
}

function writeCloseResult(input: {
  json: boolean;
  conversationId: string;
  status: 'closed' | 'kept_open' | 'already_closed';
}): void {
  if (input.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          conversationId: input.conversationId,
          status: input.status,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (input.status === 'closed') {
    process.stdout.write(
      `Closed huddle conversation ${input.conversationId}.\n`,
    );
    return;
  }

  if (input.status === 'kept_open') {
    process.stdout.write(
      `Kept huddle conversation ${input.conversationId} open.\n`,
    );
    return;
  }

  process.stdout.write(
    `Huddle conversation ${input.conversationId} was already closed.\n`,
  );
}

function ensureSwiftAvailable(): void {
  if (!canRunSwift()) {
    throw new Error(
      'Swift is required for the huddle popup and microphone capture.',
    );
  }
}

function canRunSwift(): boolean {
  const result = spawnSync('swift', ['-version'], {
    encoding: 'utf8',
  });

  return result.status === 0;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}.`);
  }

  return parsed;
}

function resolveHuddleSpeechSpeed(rawValue: string | undefined): number {
  const parsed = rawValue ? Number.parseFloat(rawValue) : Number.NaN;
  if (Number.isFinite(parsed)) {
    return Math.min(1.2, Math.max(0.7, parsed));
  }

  return DEFAULT_HUDDLE_SPEECH_SPEED;
}

function resolveCredentials(
  config: AppConfig,
  options: CredentialOptions,
): ResolvedCredentials {
  return {
    groqApiKey:
      readOptionalCliValue(options.groqApiKey) ??
      readOptionalCliValue(options.grokToken) ??
      config.apiKeys.groq,
    elevenLabsApiKey:
      readOptionalCliValue(options.elevenlabsApiKey) ??
      readOptionalCliValue(options.elevenlabsToken) ??
      config.apiKeys.elevenLabs,
  };
}

function readOptionalCliValue(value: string | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

maybeRunDirectCloseCommand(process.argv)
  .then((handled) => {
    if (handled) {
      return;
    }

    return program.parseAsync(process.argv);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
