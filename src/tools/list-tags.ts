import { z } from 'zod';
import { listTags } from '../services/memory.js';

export const listTagsSchema = z.object({
  agentName: z.string().optional().describe('Filter by agent name'),
  projectPath: z.string().optional().describe('Filter by project path'),
  limit: z.number().int().min(1).max(500).default(100).describe('Max tags to return'),
});

export async function handleListTags(args: unknown) {
  const input = listTagsSchema.parse(args);
  const result = await listTags(input.agentName, input.projectPath, input.limit);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result),
      },
    ],
  };
}
