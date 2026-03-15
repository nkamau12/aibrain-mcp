import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { getTable } from './db/init.js';
import { handleSaveMemory, saveMemorySchema } from './tools/save-memory.js';
import { handleSearchMemories, searchMemoriesSchema } from './tools/search-memories.js';
import { handleGetRecentMemories, getRecentMemoriesSchema } from './tools/get-recent-memories.js';
import { handleDeleteMemory, deleteMemorySchema } from './tools/delete-memory.js';
import { handleListTags, listTagsSchema } from './tools/list-tags.js';
import { handleGetMemory, getMemorySchema } from './tools/get-memory.js';

// Initialize DB before accepting connections
await getTable();

const server = new McpServer({
  name: 'aibrain',
  version: '0.1.0',
});

server.tool(
  'save_memory',
  'Save a memory about actions taken, decisions made, or context for future sessions',
  saveMemorySchema.shape,
  handleSaveMemory
);

server.tool(
  'search_memories',
  'Search memories using hybrid BM25 + vector semantic search with RRF fusion',
  searchMemoriesSchema.shape,
  handleSearchMemories
);

server.tool(
  'get_recent_memories',
  'Retrieve the most recent memories, optionally filtered by agent, session, or project',
  getRecentMemoriesSchema.shape,
  handleGetRecentMemories
);

server.tool(
  'delete_memory',
  'Delete a specific memory by its ID',
  deleteMemorySchema.shape,
  handleDeleteMemory
);

server.tool(
  'list_tags',
  'List all tags used in memories, sorted by usage count',
  listTagsSchema.shape,
  handleListTags
);

server.tool(
  'get_memory',
  'Fetch the full content of a single memory by ID. Use after search_memories or get_recent_memories to expand a specific result.',
  getMemorySchema.shape,
  handleGetMemory
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`[aibrain] MCP server started (${config.LOG_LEVEL} mode, data: ${config.AIBRAIN_DATA_DIR})`);
