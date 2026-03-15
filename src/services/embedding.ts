import { config } from '../config.js';

interface OllamaEmbedResponse {
  embeddings: number[][];
}

let ollamaAvailable: boolean | null = null;
let ollamaCheckTime = 0;
const CACHE_TTL_MS = 30_000;

export async function checkOllamaHealth(): Promise<boolean> {
  const now = Date.now();
  if (ollamaAvailable !== null && now - ollamaCheckTime < CACHE_TTL_MS) {
    return ollamaAvailable;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.OLLAMA_TIMEOUT_MS);

    const response = await fetch(`${config.OLLAMA_URL}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    ollamaAvailable = response.ok;
    ollamaCheckTime = now;
    return ollamaAvailable;
  } catch {
    ollamaAvailable = false;
    ollamaCheckTime = now;
    return false;
  }
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const healthy = await checkOllamaHealth();
  if (!healthy) {
    return [];
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.OLLAMA_TIMEOUT_MS);

    const response = await fetch(`${config.OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.OLLAMA_MODEL,
        input: text,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`Ollama embed failed: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as OllamaEmbedResponse;
    return data.embeddings?.[0] ?? [];
  } catch (err: any) {
    console.error('Ollama embed error:', err.message);
    ollamaAvailable = false;
    ollamaCheckTime = Date.now();
    return [];
  }
}
