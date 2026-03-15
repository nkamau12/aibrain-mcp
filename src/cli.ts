#!/usr/bin/env node
import { setupOllama, checkOllamaInstalled } from './setup/ollama.js';

const args = process.argv.slice(2);

if (args.includes('--setup')) {
  await setupOllama();
  process.exit(0);
}

// Not setup mode — print reminder if Ollama missing, then start MCP server
checkOllamaInstalled();

// Dynamic import to avoid running server code during --setup
await import('./index.js');
