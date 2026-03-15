import { z } from 'zod';
import { saveMemory } from '../services/memory.js';

export const saveMemorySchema = z.object({
  content: z.string().min(1).describe('Full memory text'),
  summary: z.string().max(200).describe('One-line summary (max 200 chars)'),
  tags: z.array(z.string()).default([]).describe('Lowercase kebab-case tags'),
  agentName: z.string().default('claude-code').describe('Agent identifier'),
  sessionId: z.string().describe('Session/conversation identifier'),
  projectPath: z.string().default('').describe('Absolute project path or empty for global'),
  metadata: z.record(z.unknown()).default({}).describe('Additional metadata'),
});

export async function handleSaveMemory(args: unknown) {
  const input = saveMemorySchema.parse(args);
  const id = await saveMemory(input);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          id,
          message: `Memory saved with id: ${id}`,
        }),
      },
    ],
  };
}
