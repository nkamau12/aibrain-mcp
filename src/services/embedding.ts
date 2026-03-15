import { config } from '../config.js';

// --- Transformers.js provider ---

let _pipeline: any = null;
let _pipelineFailedAt = 0;
const PIPELINE_RETRY_MS = 5 * 60 * 1000; // retry after 5 minutes

async function getTransformersPipeline(): Promise<any> {
  if (_pipeline) return _pipeline;
  if (_pipelineFailedAt > 0 && Date.now() - _pipelineFailedAt < PIPELINE_RETRY_MS) return null;

  try {
    const { pipeline } = await import('@huggingface/transformers');
    console.error('[aibrain] Loading embedding model on first run (may download ~50MB to ~/.cache/huggingface)...');
    _pipeline = await pipeline('feature-extraction', 'Xenova/nomic-embed-text-v1', {
      dtype: 'fp32',
    });
    _pipelineFailedAt = 0;
    console.error('[aibrain] Embedding model ready');
    return _pipeline;
  } catch (err: any) {
    console.error('[aibrain] Failed to load embedding model:', err.message);
    _pipelineFailedAt = Date.now();
    return null;
  }
}

async function generateTransformersEmbedding(text: string): Promise<number[]> {
  const extractor = await getTransformersPipeline();
  if (!extractor) return [];

  try {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  } catch (err: any) {
    console.error('[aibrain] Embedding error:', err.message);
    return [];
  }
}

// --- Ollama provider ---

let ollamaAvailable: boolean | null = null;
let ollamaCheckTime = 0;
const POSITIVE_CACHE_TTL_MS = 30_000; // healthy: recheck every 30s
const NEGATIVE_CACHE_TTL_MS = 5_000;  // unhealthy: recheck every 5s

async function checkOllamaHealth(): Promise<boolean> {
  const now = Date.now();
  const ttl = ollamaAvailable ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  if (ollamaAvailable !== null && now - ollamaCheckTime < ttl) {
    return ollamaAvailable;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.OLLAMA_TIMEOUT_MS);
    const response = await fetch(`${config.OLLAMA_URL}/api/tags`, { signal: controller.signal });
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

async function generateOllamaEmbedding(text: string): Promise<number[]> {
  const healthy = await checkOllamaHealth();
  if (!healthy) return [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.OLLAMA_TIMEOUT_MS);
    const response = await fetch(`${config.OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.OLLAMA_MODEL, input: text }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[aibrain] Ollama embed failed: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings?.[0] ?? [];
  } catch (err: any) {
    console.error('[aibrain] Ollama embed error:', err.message);
    ollamaAvailable = false;
    ollamaCheckTime = Date.now();
    return [];
  }
}

// --- Public API ---

export async function isEmbeddingAvailable(): Promise<boolean> {
  if (config.EMBEDDING_PROVIDER === 'ollama') {
    return checkOllamaHealth();
  }
  // transformers: unavailable only within the retry cooldown window
  return !(_pipelineFailedAt > 0 && Date.now() - _pipelineFailedAt < PIPELINE_RETRY_MS);
}

export async function generateEmbedding(text: string): Promise<number[]> {
  if (config.EMBEDDING_PROVIDER === 'ollama') {
    return generateOllamaEmbedding(text);
  }
  return generateTransformersEmbedding(text);
}
