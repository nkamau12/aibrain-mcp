import { z } from 'zod';
import { getMemoryById } from '../services/memory.js';

export const getMemorySchema = z.object({
  id: z.string().min(1).describe('The memory ID to fetch'),
});

export async function handleGetMemory(args: unknown) {
  const input = getMemorySchema.parse(args);
  const memory = await getMemoryById(input.id);
  return {
    content: [
      {
        type: 'text' as const,
        text: memory ? JSON.stringify(memory) : JSON.stringify({ error: 'Memory not found', id: input.id }),
      },
    ],
  };
}
