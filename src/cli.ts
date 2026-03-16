#!/usr/bin/env node
import { config } from './config.js';
import { setupOllama } from './setup/ollama.js';
import { setupUI } from './setup/ui.js';

const args = process.argv.slice(2);

if (args.includes('--setup-ui')) {
  await setupUI();
  process.exit(0);
}

if (args.includes('--setup')) {
  if (config.EMBEDDING_PROVIDER === 'ollama') {
    await setupOllama();
  } else {
    console.error('[aibrain] Using Transformers.js (default) — no setup needed.');
    console.error('[aibrain] The embedding model will download automatically on first run.');
    console.error('[aibrain] To use Ollama instead, set EMBEDDING_PROVIDER=ollama and re-run with --setup.');
  }
  process.exit(0);
}

// Dynamic import to avoid running server code during --setup
await import('./index.js');
