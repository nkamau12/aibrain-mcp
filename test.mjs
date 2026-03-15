/**
 * aiBrain MCP — integration test suite
 * Uses Node built-in test runner (Node 20+).
 *
 * Usage:
 *   node --test test.mjs
 *   EMBEDDING_PROVIDER=ollama node --test test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// ── Isolated temp data dir so tests never touch ~/.aibrain ──────────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aibrain-test-'));
process.env.AIBRAIN_DATA_DIR = TEST_DIR;

// Load services after env is set
const { saveMemory, searchMemories, getRecentMemories, getMemoryById, deleteMemory } =
  await import('./dist/services/memory.js');
const { generateEmbedding, isEmbeddingAvailable } =
  await import('./dist/services/embedding.js');
const { config } = await import('./dist/config.js');

const PROVIDER = config.EMBEDDING_PROVIDER;
const PROJECT = `/test-${Date.now()}`;

console.log(`\nProvider: ${PROVIDER}  |  Data dir: ${TEST_DIR}\n`);

after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── Embedding ────────────────────────────────────────────────────────────────

test('isEmbeddingAvailable returns true', async () => {
  const available = await isEmbeddingAvailable();
  assert.equal(available, true);
});

test('generateEmbedding returns 768-dim vector', async () => {
  const vec = await generateEmbedding('hello world');
  assert.ok(vec.length === 768, `expected 768 dims, got ${vec.length}`);
  assert.ok(vec.every((v) => typeof v === 'number' && isFinite(v)), 'all values must be finite numbers');
});

test('generateEmbedding returns different vectors for different texts', async () => {
  const [a, b] = await Promise.all([
    generateEmbedding('authentication security'),
    generateEmbedding('database performance'),
  ]);
  const same = a.every((v, i) => v === b[i]);
  assert.ok(!same, 'different texts should produce different embeddings');
});

// ── save_memory ──────────────────────────────────────────────────────────────

let savedId;

test('saveMemory returns a UUID', async () => {
  savedId = await saveMemory({
    content: 'Fixed a race condition in the job queue where two workers could claim the same task.',
    summary: 'Fixed job queue race condition',
    tags: ['bug-fix', 'concurrency'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: PROJECT,
    metadata: { severity: 'high' },
  });
  assert.match(savedId, /^[0-9a-f-]{36}$/, 'should return a UUID');
});

test('saveMemory stores a second memory', async () => {
  const id = await saveMemory({
    content: 'Implemented Redis-based session caching to reduce database load during peak traffic hours.',
    summary: 'Added Redis session cache',
    tags: ['performance', 'caching'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: PROJECT,
    metadata: {},
  });
  assert.match(id, /^[0-9a-f-]{36}$/);
});

// ── get_recent_memories ──────────────────────────────────────────────────────

test('getRecentMemories returns both saved memories', async () => {
  // Wait briefly for FTS index rebuild
  await new Promise((r) => setTimeout(r, 1500));

  const { memories, total } = await getRecentMemories(10, { projectPath: PROJECT });
  assert.equal(total, 2, `expected 2 memories, got ${total}`);
  assert.ok(memories.every((m) => m.id && m.summary), 'each result has id and summary');
});

test('getRecentMemories filters by projectPath', async () => {
  const { total } = await getRecentMemories(10, { projectPath: '/nonexistent' });
  assert.equal(total, 0);
});

// ── get_memory ───────────────────────────────────────────────────────────────

test('getMemoryById returns full content', async () => {
  const mem = await getMemoryById(savedId);
  assert.ok(mem, 'should find the memory');
  assert.equal(mem.id, savedId);
  assert.ok(mem.content.includes('race condition'), 'content should be intact');
  assert.deepEqual(Array.from(mem.tags ?? []), ['bug-fix', 'concurrency']);
});

test('getMemoryById returns null for unknown id', async () => {
  const mem = await getMemoryById('00000000-0000-0000-0000-000000000000');
  assert.equal(mem, null);
});

// ── search_memories ──────────────────────────────────────────────────────────

test('fulltext search finds relevant memory', async () => {
  const { results, searchMode } = await searchMemories({
    query: 'race condition concurrency',
    searchMode: 'fulltext',
    limit: 5,
    filters: { projectPath: PROJECT },
  });
  assert.equal(searchMode, 'fulltext');
  assert.ok(results.length > 0, 'should return results');
  assert.ok(
    results.some((r) => r.summary.includes('race condition')),
    'should rank the race condition memory'
  );
});

test('fulltext search for caching returns caching memory', async () => {
  const { results } = await searchMemories({
    query: 'Redis caching session',
    searchMode: 'fulltext',
    limit: 5,
    filters: { projectPath: PROJECT },
  });
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.summary.includes('Redis')));
});

test('vector search returns results', async () => {
  const { results, searchMode } = await searchMemories({
    query: 'concurrency bug fix',
    searchMode: 'vector',
    limit: 5,
    filters: { projectPath: PROJECT },
  });
  // Falls back to fulltext if embedding unavailable, still returns results
  assert.ok(['vector', 'fulltext'].includes(searchMode));
  assert.ok(results.length > 0);
});

test('hybrid search returns results', async () => {
  const { results, searchMode } = await searchMemories({
    query: 'performance database caching',
    searchMode: 'hybrid',
    limit: 5,
    filters: { projectPath: PROJECT },
  });
  assert.ok(['hybrid', 'fulltext'].includes(searchMode));
  assert.ok(results.length > 0);
});

test('search with tag filter returns only tagged memories', async () => {
  const { results } = await searchMemories({
    query: 'memory',
    searchMode: 'fulltext',
    limit: 10,
    filters: { projectPath: PROJECT, tags: ['bug-fix'] },
  });
  assert.ok(results.every((r) => (r.tags ?? []).includes('bug-fix')));
});

// ── delete_memory ────────────────────────────────────────────────────────────

test('deleteMemory removes the memory', async () => {
  const { success } = await deleteMemory(savedId);
  assert.equal(success, true);

  const mem = await getMemoryById(savedId);
  assert.equal(mem, null, 'memory should be gone after deletion');
});

test('deleteMemory on unknown id returns success (idempotent)', async () => {
  const { success } = await deleteMemory('00000000-0000-0000-0000-000000000000');
  assert.equal(success, true);
});
