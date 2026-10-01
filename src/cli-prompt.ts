import { RequestError } from '@agentclientprotocol/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AmpExecutionRequest, AmpPromptContent } from './amp-transport.js';

const MAX_INPUT_BYTES = 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function formatPromptInput(prompt: AmpExecutionRequest['prompt'], steer: boolean): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt,
    },
    steer,
  })}\n`;
}

/** Keep original images on disk when their combined inline input exceeds Amp's limit. */
export function prepareCliPrompt(
  prompt: AmpExecutionRequest['prompt'],
  imageDirectory: string,
): AmpExecutionRequest['prompt'] {
  const inputBytes = Buffer.byteLength(formatPromptInput(prompt, false), 'utf8');
  if (inputBytes <= MAX_INPUT_BYTES) return prompt;

  const files: { filePath: string; bytes: Buffer }[] = [];
  const content = typeof prompt === 'string' ? prompt : prompt.map((part): AmpPromptContent => {
    if (part.type !== 'image') return part;
    const bytes = Buffer.from(part.source.data, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const extension = IMAGE_EXTENSIONS[part.source.media_type];
    if (!extension) throw RequestError.invalidParams(undefined, `Unsupported image format: ${part.source.media_type}`);
    const filePath = path.resolve(imageDirectory, `${hash}.${extension}`);
    files.push({ filePath, bytes });
    return {
      type: 'text',
      text: `Image attachment (original ${part.source.media_type}): ${JSON.stringify(filePath)}\nUse view_media or another image-viewing tool to open and inspect this file before answering.`,
    };
  });
  if (Buffer.byteLength(formatPromptInput(content, false), 'utf8') > MAX_INPUT_BYTES) {
    throw RequestError.invalidParams(undefined,
      `Amp CLI input exceeds the ${MAX_INPUT_BYTES}-byte limit. Reduce the text or embedded context and try again.`);
  }

  // Synchronous preparation keeps the prompt/controller concurrency gate atomic.
  // Files persist across cancellation and resume because Amp history references them.
  mkdirSync(imageDirectory, { recursive: true, mode: 0o700 });
  for (const { filePath, bytes } of files) {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, filePath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return content;
}
