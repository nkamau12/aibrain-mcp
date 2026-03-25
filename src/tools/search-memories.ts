import { z } from 'zod';
import { searchMemories } from '../services/memory.js';

export const searchMemoriesSchema = z.object({
  query: z.string().min(1).describe('Search query'),
  limit: z.number().int().min(1).max(50).default(10).describe('Max results (default 10, max 50)'),
  filters: z
    .object({
      agentName: z.string().optional(),
      sessionId: z.string().optional(),
      projectPath: z.string().optional(),
      tags: z.array(z.string()).optional(),
      since: z.string().optional().describe('ISO 8601 date'),
      until: z.string().optional().describe('ISO 8601 date'),
      cluster: z.string().optional().describe('Cluster name to filter by (overrides AIBRAIN_DEFAULT_CLUSTER)'),
    })
    .optional(),
  searchMode: z.enum(['hybrid', 'fulltext', 'vector']).default('hybrid'),
  rrfK: z.number().default(60).describe('RRF k parameter'),
  includeContent: z.boolean().default(false).describe('Include full content in results (default false — use get_memory for full content)'),
  contentMaxLength: z.number().int().min(0).default(500).describe('Max chars of content when includeContent is true (0 = unlimited)'),
});

export async function handleSearchMemories(args: unknown) {
  const input = searchMemoriesSchema.parse(args);
  const result = await searchMemories({
    ...input,
    resultOptions: { includeContent: input.includeContent, contentMaxLength: input.contentMaxLength },
  });
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result),
      },
    ],
  };
}
