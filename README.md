# aiBrain MCP

AI agent memory server with hybrid BM25 + vector search. No Docker required — runs anywhere via `npx`.

## Quick Start

```bash
# Add to Claude Code (or any MCP client)
npx -y @aibrain/mcp

# Optional: install Ollama for semantic search
npx -y @aibrain/mcp --setup

# Optional: set up the web dashboard
npx -y @aibrain/mcp --setup-ui
npx -y @aibrain/mcp --setup-ui ~/projects   # custom location
```

## Features

- **7 memory tools**: `save_memory`, `search_memories`, `get_recent_memories`, `get_memory`, `get_related_memories`, `delete_memory`, `list_tags`
- **Hybrid search**: BM25 full-text + vector semantic search with Reciprocal Rank Fusion
- **Zero external dependencies**: embedded LanceDB + local ONNX embeddings via Transformers.js — no separate server needed
- **Persistent storage**: memories saved to `~/.aibrain/memories` by default
- **First-run model download**: the `nomic-embed-text-v1` ONNX model (~50MB) downloads once to `~/.cache/huggingface` and is reused on all subsequent runs

---

## Client Integration

### Claude Code

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

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

### Cursor

Add to `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` globally:

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

### Amp

Add to `~/.config/amp/settings.json` (global) or `.amp/settings.json` in your project root:

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

---

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `AIBRAIN_DATA_DIR` | `~/.aibrain/memories` | Where memories are stored |
| `AIBRAIN_DEFAULT_CLUSTER` | _(none)_ | Default cluster applied to every saved memory when `cluster` is not explicitly set |
| `AIBRAIN_AUTO_LINK_THRESHOLD` | `0.85` | Cosine similarity threshold above which a newly saved memory is automatically linked to similar existing ones |
| `AIBRAIN_AUTO_LINK_LIMIT` | `3` | Maximum number of auto-links created per save |
| `EMBEDDING_PROVIDER` | `transformers` | Embedding backend: `transformers` or `ollama` |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL (only used when `EMBEDDING_PROVIDER=ollama`) |
| `OLLAMA_MODEL` | `nomic-embed-text` | Ollama embedding model (only used when `EMBEDDING_PROVIDER=ollama`) |
| `OLLAMA_TIMEOUT_MS` | `5000` | Ollama request timeout (only used when `EMBEDDING_PROVIDER=ollama`) |
| `LOG_LEVEL` | `info` | Log level (debug/info/warn/error) |

Set these in your shell profile or pass them via `env` in your MCP client config:

```json
{
  "mcpServers": {
    "aibrain": {
      "command": "npx",
      "args": ["-y", "@aibrain/mcp"],
      "env": {
        "AIBRAIN_DATA_DIR": "/custom/path/to/memories"
      }
    }
  }
}
```

---

## CLI Flags

| Flag | Description |
|------|-------------|
| `--setup` | Install Ollama and pull the embedding model (only needed for `EMBEDDING_PROVIDER=ollama`) |
| `--setup-ui` | Clone and set up the [aibrain-ui](https://github.com/nkamau12/aibrain-ui) web dashboard |
| `--setup-ui <path>` | Clone aibrain-ui into a custom directory (defaults to current directory) |

---

## Tools

### `save_memory`
Save a memory with content, summary, tags, and metadata.

Key fields:
- `projectPath` — absolute path of the working directory (or `""` for global context)
- `summary` — under 200 chars; shown in search result lists
- `content` — full detail
- `tags` — lowercase kebab-case array (e.g. `["bug-fix", "architecture"]`)
- `cluster` — subsystem or domain label in lowercase kebab-case (e.g. `"auth-system"`, `"payment-flow"`). Used to scope searches to a subsystem. Falls back to `AIBRAIN_DEFAULT_CLUSTER` if not set.
- `related_ids` — array of objects linking this memory to others: `{ "id": "<uuid>", "relation_type": "supersedes" | "caused-by" | "see-also" | "follow-up" | "similar" (auto-assigned) }`. Back-links are created automatically. Note: `similar` is assigned automatically by the system when auto-linking fires — do not set it manually.

### `search_memories`
Hybrid BM25 + vector search with Reciprocal Rank Fusion. Falls back to fulltext if embeddings are unavailable.

Additional options:
- `include_related` _(boolean)_ — when `true`, each result includes its directly linked neighbours so you can surface related context without a second round-trip
- `related_depth` _(1–2)_ — how many hops to traverse when `include_related` is `true` (default 1)

### `get_related_memories`
Traverse the memory graph starting from a single memory.

Inputs:
- `id` — starting memory UUID
- `depth` _(1–3)_ — how many hops to follow
- `relation_types` — optional filter: `["supersedes", "caused-by", "see-also", "follow-up", "similar"]` (`similar` is auto-assigned by the system)
- `include_content` _(boolean)_ — whether to include full content in results (default false)

Use this when a search result has interesting neighbours and you want to follow the chain deeper. Don't traverse every result automatically — only when the chain looks directly relevant.

### `get_recent_memories`
Get most recent memories, optionally filtered by agent, session, or project.

### `get_memory`
Fetch full content of a memory by ID.

### `delete_memory`
Delete a memory by ID.

### `list_tags`
List all tags sorted by usage count.

---

## Embeddings

### Default: Transformers.js (no setup required)

Embeddings run locally via [Transformers.js](https://huggingface.co/docs/transformers.js) using the `nomic-embed-text-v1` ONNX model.

**On first run**, the model (~50MB) downloads automatically to `~/.cache/huggingface/hub`. You'll see:

```
[aibrain] Loading embedding model on first run (may download ~50MB to ~/.cache/huggingface)...
[aibrain] Embedding model ready
```

Every subsequent run loads the model from disk instantly — no network call.

### Alternative: Ollama

If you prefer Ollama (e.g. you're already running it, or want GPU acceleration):

```bash
# Install Ollama and pull the model
npx -y @aibrain/mcp --setup

# Then tell aibrain to use it
EMBEDDING_PROVIDER=ollama npx -y @aibrain/mcp
```

Or set it permanently in your MCP client config:

```json
{
  "mcpServers": {
    "aibrain": {
      "command": "npx",
      "args": ["-y", "@aibrain/mcp"],
      "env": {
        "EMBEDDING_PROVIDER": "ollama"
      }
    }
  }
}
```

---

## Agent Instructions

Installing the MCP server gives your AI agent access to the tools, but you also need to tell it **when and how to use them**. Add the instructions below to your agent's rules/instructions file.

### Where to put them

| Scope | Claude Code | Amp | Cursor |
|-------|------------|-----|--------|
| Global (all projects) | `~/.claude/CLAUDE.md` | `~/.config/amp/AGENTS.md` | `~/.cursor/rules` |
| Project-local | `CLAUDE.md` in project root | `.amp/AGENTS.md` in project root | `.cursor/rules` in project root |

Use **global** for general memory behaviour you always want. Use **project-local** to scope memories to a specific codebase or workflow.

### Recommended instructions

Add this block to your chosen file:

````markdown
## Memory (aiBrain)

At the start of every session:
1. Call `aibrain:get_recent_memories` (limit: 10, filter by current `projectPath`)
2. Call `aibrain:search_memories` with a query summarizing what the user just asked,
   and set `include_related: true` to surface related context in one call
3. For any result or neighbour that looks relevant, call `aibrain:get_memory`
   with its `id` to fetch full content

When saving:
- `projectPath`: absolute path of the current working directory
- `cluster`: the subsystem or domain (e.g. "auth-system", "payment-flow")
- `tags`: lowercase kebab-case
- `summary`: under 200 chars
- `content`: full detail
- `related_ids`: link to any recently retrieved memories with the appropriate
  `relation_type` (supersedes, caused-by, follow-up, see-also, similar — auto-assigned)

When a search result has neighbours (via `include_related`), use
`get_related_memories` to traverse deeper only when the chain looks
directly relevant — don't traverse every result automatically.

## Directory Exploration → aiBrain

Whenever you read or explore a directory and discover new information (project structure, tech stack, conventions, dependencies, config patterns, etc.) that isn't already in aiBrain, save it immediately with `aibrain:save_memory`. Tag with `codebase-discovery` plus any relevant tags.

## aiBrain Subagents

Run all aiBrain operations (save, search, get, delete) as background subagents where possible, so they don't block the main conversation. Batch multiple saves into a single subagent call. Only await aiBrain results when the response directly depends on them (e.g. session-start memory load).
````

### Minimal version

If you want lighter-touch behaviour, this shorter version works well:

````markdown
## Memory (aiBrain)

- At session start: call `aibrain:get_recent_memories` and `aibrain:search_memories` to load relevant context
- During work: call `aibrain:save_memory` for decisions, bugs, conventions, and user preferences
- At session end: save a summary of what was done and what's left
- Always set `projectPath` to the current working directory when saving
````

---

## Web Dashboard (aibrain-ui)

Browse, search, and manage your memories visually with **[aibrain-ui](https://github.com/nkamau12/aibrain-ui)** — a dark-themed web dashboard built on top of aibrain-mcp.

### Automatic setup

```bash
# Clones aibrain-ui into current directory
npx -y @aibrain/mcp --setup-ui

# Or specify a custom location
npx -y @aibrain/mcp --setup-ui ~/projects
```

This clones aibrain-ui, installs dependencies, and creates the `.env` file. Then:

```bash
cd aibrain-ui
npm run dev
```

Dashboard opens at [http://localhost:5173](http://localhost:5173).

### Manual setup

See the [aibrain-ui README](https://github.com/nkamau12/aibrain-ui#readme) for manual installation instructions.

---

## Troubleshooting

**Server doesn't start**
- Ensure Node.js >= 20 is installed: `node --version`

**First run is slow / hangs**
- The embedding model is downloading (~50MB). Wait for `[aibrain] Embedding model ready` to appear. This only happens once.

**Search returns no results**
- Check that memories have been saved first via `get_recent_memories`
- If using `EMBEDDING_PROVIDER=ollama`, verify Ollama is running: `curl http://localhost:11434/api/tags`

**Embedding model fails to load**
- Check you have internet access for the one-time download
- Check available disk space (`~/.cache/huggingface` needs ~200MB for model files)
- To force a re-download, delete `~/.cache/huggingface/hub/models--Xenova--nomic-embed-text-v1`

**Ollama setup fails** (when using `EMBEDDING_PROVIDER=ollama`)
- Run `EMBEDDING_PROVIDER=ollama npx -y @aibrain/mcp --setup` again — it's idempotent
- Or install Ollama manually from [ollama.com](https://ollama.com), then `ollama pull nomic-embed-text`

**Memories stored in wrong location**
- Set `AIBRAIN_DATA_DIR` to your preferred path (see Configuration above)

---

## License

MIT
