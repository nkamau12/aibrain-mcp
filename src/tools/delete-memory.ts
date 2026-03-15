import { z } from 'zod';
import { deleteMemory } from '../services/memory.js';

export const deleteMemorySchema = z.object({
  id: z.string().min(1).describe('The memory ID to delete'),
});

export async function handleDeleteMemory(args: unknown) {
  const input = deleteMemorySchema.parse(args);
  const result = await deleteMemory(input.id);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result),
      },
    ],
  };
}
