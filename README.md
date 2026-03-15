# aiBrain MCP

AI agent memory server with hybrid BM25 + vector search. No Docker required — runs anywhere via `npx`.

## Quick Start

```bash
# Add to Claude Code (or any MCP client)
npx -y @aibrain/mcp

# Optional: install Ollama for semantic search
npx -y @aibrain/mcp --setup
```

## Features

- **6 memory tools**: `save_memory`, `search_memories`, `get_recent_memories`, `get_memory`, `delete_memory`, `list_tags`
- **Hybrid search**: BM25 full-text + vector semantic search with Reciprocal Rank Fusion
- **Zero dependencies**: embedded LanceDB, no external DB server needed
- **Persistent storage**: memories saved to `~/.aibrain/memories` by default
- **Ollama optional**: works in fulltext-only mode if Ollama is unavailable

## Claude Code Integration

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "aibrain": {
      "command": "npx",
      "args": ["-y", "@aibrain/mcp"]
    }
  }
}
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `AIBRAIN_DATA_DIR` | `~/.aibrain/memories` | Where memories are stored |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `nomic-embed-text` | Embedding model |
| `OLLAMA_TIMEOUT_MS` | `5000` | Ollama request timeout |
| `LOG_LEVEL` | `info` | Log level (debug/info/warn/error) |

## Tools

### `save_memory`
Save a memory with content, summary, tags, and metadata.

### `search_memories`
Hybrid BM25 + vector search. Falls back to fulltext if Ollama is unavailable.

### `get_recent_memories`
Get most recent memories, optionally filtered by agent, session, or project.

### `get_memory`
Fetch full content of a memory by ID.

### `delete_memory`
Delete a memory by ID.

### `list_tags`
List all tags sorted by usage count.

## Setup (Ollama for Semantic Search)

```bash
npx -y @aibrain/mcp --setup
```

This will:
1. Install Ollama if not present (macOS/Linux)
2. Pull the `nomic-embed-text` embedding model
3. Start Ollama in the background

## License

MIT
