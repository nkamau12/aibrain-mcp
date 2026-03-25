import { z } from 'zod';
import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

dotenv.config();

const configSchema = z.object({
  AIBRAIN_DATA_DIR: z.string().default(path.join(os.homedir(), '.aibrain', 'memories')),
  EMBEDDING_PROVIDER: z.enum(['transformers', 'ollama']).default('transformers'),
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('nomic-embed-text'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().default(5000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  AIBRAIN_DEFAULT_CLUSTER: z.string().default(''),
  AIBRAIN_AUTO_LINK_THRESHOLD: z.coerce.number().default(0.85),
  AIBRAIN_AUTO_LINK_LIMIT: z.coerce.number().default(3),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid configuration:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
