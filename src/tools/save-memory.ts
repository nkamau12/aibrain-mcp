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
  cluster: z
    .string()
    .regex(/^[a-z0-9-]{0,64}$/)
    .default('')
    .describe('Logical domain/subsystem (e.g. "auth-system", "payment-flow")'),
  related_ids: z
    .array(
      z.object({
        id: z.string(),
        relation_type: z.enum(['supersedes', 'caused-by', 'see-also', 'follow-up']),
      })
    )
    .default([])
    .describe('Related memory IDs with typed relationships'),
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
