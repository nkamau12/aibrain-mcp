import { z } from 'zod';
import { getRecentMemories } from '../services/memory.js';

export const getRecentMemoriesSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe('Max results (default 20, max 100)'),
  filters: z
    .object({
      agentName: z.string().optional(),
      sessionId: z.string().optional(),
      projectPath: z.string().optional(),
      tags: z.array(z.string()).optional(),
      since: z.string().optional(),
      until: z.string().optional(),
    })
    .optional(),
  includeContent: z.boolean().default(false).describe('Include full content in results (default false — use get_memory for full content)'),
  contentMaxLength: z.number().int().min(0).default(500).describe('Max chars of content when includeContent is true (0 = unlimited)'),
});

export async function handleGetRecentMemories(args: unknown) {
  const input = getRecentMemoriesSchema.parse(args);
  const result = await getRecentMemories(
    input.limit,
    input.filters,
    { includeContent: input.includeContent, contentMaxLength: input.contentMaxLength }
  );
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result),
      },
    ],
  };
}
