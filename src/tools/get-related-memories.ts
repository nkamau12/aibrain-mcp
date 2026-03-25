import { z } from 'zod';
import { getRelatedMemories } from '../services/memory.js';

export const getRelatedMemoriesSchema = z.object({
  id: z.string().uuid().describe('The root memory ID to traverse from'),
  depth: z.number().int().min(1).max(3).default(1).describe('How many hops to follow (1–3)'),
  relation_types: z
    .array(z.string())
    .optional()
    .describe('Filter to specific relation types (e.g. ["supersedes", "follow-up"])'),
  include_content: z
    .boolean()
    .default(false)
    .describe('Whether to include full content in each returned node'),
  include_stale: z
    .boolean()
    .default(false)
    .describe('Include stale (superseded) memories in traversal'),
});

export async function handleGetRelatedMemories(args: unknown) {
  const input = getRelatedMemoriesSchema.parse(args);
  const result = await getRelatedMemories(
    input.id,
    input.depth,
    input.relation_types,
    input.include_content,
    input.include_stale
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
