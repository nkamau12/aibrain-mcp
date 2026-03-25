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
const {
  saveMemory,
  searchMemories,
  getRecentMemories,
  getMemoryById,
  deleteMemory,
  getRelatedMemories,
  sanitizeFilterValue,
} = await import('./dist/services/memory.js');
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

// ── cluster ──────────────────────────────────────────────────────────────────

// Cluster tests use their own isolated project path to avoid interference
const CLUSTER_PROJECT = `/test-cluster-${Date.now()}`;

let clusterMemId;

test('saveMemory persists cluster value', async () => {
  clusterMemId = await saveMemory({
    content: 'Auth service refactored to use JWT tokens instead of sessions.',
    summary: 'Auth refactor: JWT tokens',
    tags: ['auth'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: CLUSTER_PROJECT,
    metadata: {},
    cluster: 'auth-system',
  });
  assert.match(clusterMemId, /^[0-9a-f-]{36}$/);

  const mem = await getMemoryById(clusterMemId);
  assert.ok(mem, 'memory should be retrievable');
  assert.equal(mem.cluster, 'auth-system', 'cluster should be persisted');
});

test('saveMemory persists a second memory in a different cluster', async () => {
  await saveMemory({
    content: 'Payment flow updated to support multiple currencies via Stripe.',
    summary: 'Payment: multi-currency support',
    tags: ['payments'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: CLUSTER_PROJECT,
    metadata: {},
    cluster: 'payment-flow',
  });
  // Wait for FTS index rebuild before searching
  await new Promise((r) => setTimeout(r, 1500));
});

test('search with cluster filter returns only matching cluster memories', async () => {
  const { results } = await searchMemories({
    query: 'auth payment',
    searchMode: 'fulltext',
    limit: 10,
    filters: { projectPath: CLUSTER_PROJECT, cluster: 'auth-system' },
  });
  assert.ok(results.length > 0, 'should return results for auth-system cluster');
  assert.ok(
    results.every((r) => r.cluster === 'auth-system'),
    'all results must belong to the auth-system cluster'
  );
});

test('search without cluster filter returns memories from all clusters', async () => {
  const { results } = await searchMemories({
    query: 'auth payment',
    searchMode: 'fulltext',
    limit: 10,
    filters: { projectPath: CLUSTER_PROJECT },
  });
  const clusters = new Set(results.map((r) => r.cluster).filter(Boolean));
  assert.ok(clusters.size >= 2, 'should return memories from multiple clusters');
});

test('sanitizeFilterValue rejects cluster with uppercase letters', () => {
  assert.throws(
    () => sanitizeFilterValue('Auth-System', 'cluster'),
    /must match/,
    'uppercase letters should be rejected'
  );
});

test('sanitizeFilterValue rejects cluster with special characters', () => {
  assert.throws(
    () => sanitizeFilterValue('auth_system!', 'cluster'),
    /must match/,
    'special characters should be rejected'
  );
});

test('sanitizeFilterValue rejects cluster exceeding 64 characters', () => {
  const longCluster = 'a'.repeat(65);
  assert.throws(
    () => sanitizeFilterValue(longCluster, 'cluster'),
    /exceeds maximum length|must match/,
    'cluster value over 64 chars should be rejected'
  );
});

test('sanitizeFilterValue accepts valid cluster values', () => {
  assert.doesNotThrow(() => sanitizeFilterValue('auth-system', 'cluster'));
  assert.doesNotThrow(() => sanitizeFilterValue('payment-flow-2', 'cluster'));
  assert.doesNotThrow(() => sanitizeFilterValue('abc123', 'cluster'));
});

// ── related_ids and back-linking ──────────────────────────────────────────────

const RELATED_PROJECT = `/test-related-${Date.now()}`;

let memoryAId;
let memoryBId;

test('saveMemory without related_ids defaults to empty', async () => {
  memoryAId = await saveMemory({
    content: 'Discovered a memory leak in the websocket connection pool.',
    summary: 'Memory leak in websocket pool',
    tags: ['bug'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: RELATED_PROJECT,
    metadata: {},
  });
  assert.match(memoryAId, /^[0-9a-f-]{36}$/);

  const mem = await getMemoryById(memoryAId);
  assert.ok(mem, 'memory A should exist');
  // related_ids should not be present or should be empty when not provided
  const relatedIds = mem.related_ids ?? [];
  assert.equal(relatedIds.length, 0, 'related_ids should default to empty');
});

test('saveMemory with related_ids stores forward links', async () => {
  memoryBId = await saveMemory({
    content: 'Fixed the memory leak in websocket pool by implementing connection lifecycle management.',
    summary: 'Fixed websocket pool memory leak',
    tags: ['bug-fix'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: RELATED_PROJECT,
    metadata: {},
    related_ids: [{ id: memoryAId, relation_type: 'caused-by' }],
  });
  assert.match(memoryBId, /^[0-9a-f-]{36}$/);

  const memB = await getMemoryById(memoryBId);
  assert.ok(memB, 'memory B should exist');
  assert.ok(Array.isArray(memB.related_ids) && memB.related_ids.length > 0, 'B should have forward links');
  assert.ok(
    memB.related_ids.some((r) => r.id === memoryAId && r.relation_type === 'caused-by'),
    'forward link to A with correct relation type should be stored'
  );
});

test('back-links are created on referenced memory (fire-and-forget)', async () => {
  // Wait for the fire-and-forget back-linking to complete
  await new Promise((r) => setTimeout(r, 1500));

  const memA = await getMemoryById(memoryAId);
  assert.ok(memA, 'memory A should still exist');
  const relatedIds = memA.related_ids ?? [];
  assert.ok(
    relatedIds.some((r) => r.id === memoryBId),
    'A should have a back-link to B after fire-and-forget'
  );
});

test('duplicate related_ids links are prevented', async () => {
  // Save a third memory also pointing to A — the back-link on A from B should stay unique
  await saveMemory({
    content: 'Another fix attempt for the websocket leak.',
    summary: 'Second websocket fix attempt',
    tags: ['bug-fix'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: RELATED_PROJECT,
    metadata: {},
    related_ids: [{ id: memoryAId, relation_type: 'see-also' }],
  });

  await new Promise((r) => setTimeout(r, 1500));

  const memA = await getMemoryById(memoryAId);
  const linksToB = (memA.related_ids ?? []).filter((r) => r.id === memoryBId);
  assert.equal(linksToB.length, 1, 'back-link to B should not be duplicated on A');
});

// ── get_related_memories ──────────────────────────────────────────────────────

test('getRelatedMemories depth 1 returns only direct links', async () => {
  const result = await getRelatedMemories(memoryBId, 1);
  assert.ok(result.root, 'should have a root node');
  assert.equal(result.root.id, memoryBId);
  assert.ok(Array.isArray(result.nodes), 'nodes should be an array');
  // Depth 1: only immediate neighbors
  assert.ok(result.nodes.every((n) => n.depth === 1), 'all nodes should be at depth 1');
  assert.ok(
    result.nodes.some((n) => n.id === memoryAId),
    'direct link to A should appear at depth 1'
  );
});

test('getRelatedMemories depth 2 returns links of links', async () => {
  // Set up a chain: C -> B -> A
  const memoryCId = await saveMemory({
    content: 'Deployed the websocket pool fix to production.',
    summary: 'Deployed websocket fix to production',
    tags: ['deployment'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: RELATED_PROJECT,
    metadata: {},
    related_ids: [{ id: memoryBId, relation_type: 'follow-up' }],
  });

  await new Promise((r) => setTimeout(r, 500));

  const result = await getRelatedMemories(memoryCId, 2);
  assert.ok(result.root, 'should have a root');
  assert.equal(result.root.id, memoryCId);

  const depth1Ids = result.nodes.filter((n) => n.depth === 1).map((n) => n.id);
  const depth2Ids = result.nodes.filter((n) => n.depth === 2).map((n) => n.id);

  assert.ok(depth1Ids.includes(memoryBId), 'B should appear at depth 1');
  // A is a link of B, so it should appear at depth 2
  assert.ok(depth2Ids.includes(memoryAId), 'A should appear at depth 2');
});

test('getRelatedMemories handles cycles without infinite loops', async () => {
  // Create two memories that link to each other via back-linking
  const cycleProject = `/test-cycle-${Date.now()}`;

  const cycleAId = await saveMemory({
    content: 'Cycle memory A for cycle detection test.',
    summary: 'Cycle memory A',
    tags: ['test'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: cycleProject,
    metadata: {},
  });

  const cycleBId = await saveMemory({
    content: 'Cycle memory B linking back to A to form a cycle.',
    summary: 'Cycle memory B',
    tags: ['test'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: cycleProject,
    metadata: {},
    related_ids: [{ id: cycleAId, relation_type: 'see-also' }],
  });

  // Wait for back-link from B->A to be established on A (fire-and-forget)
  await new Promise((r) => setTimeout(r, 1500));

  // Now A links to B (via back-link) and B links to A — a cycle
  // getRelatedMemories should terminate without infinite recursion
  const result = await getRelatedMemories(cycleAId, 3);
  assert.ok(result.root, 'should return a root');
  // The important invariant: each ID appears at most once in nodes.
  const ids = result.nodes.map((n) => n.id);
  const uniqueIds = new Set(ids);
  assert.equal(ids.length, uniqueIds.size, 'no node ID should appear more than once (cycle-safe)');
});

test('getRelatedMemories returns error for non-existent root ID', async () => {
  const result = await getRelatedMemories('00000000-0000-0000-0000-000000000000', 1);
  assert.equal(result.root, null, 'root should be null for unknown ID');
  assert.ok(result.error, 'should include an error message');
  assert.ok(Array.isArray(result.nodes) && result.nodes.length === 0, 'nodes should be empty');
});

// ── include_related on search_memories ───────────────────────────────────────

test('searchMemories without include_related returns results without related field', async () => {
  await new Promise((r) => setTimeout(r, 500));

  const { results } = await searchMemories({
    query: 'websocket memory leak',
    searchMode: 'fulltext',
    limit: 5,
    filters: { projectPath: RELATED_PROJECT },
    include_related: false,
  });
  assert.ok(results.length > 0, 'should return results');
  // No result should have a related field when include_related is false
  assert.ok(
    results.every((r) => r.related === undefined),
    'results should not have a related field when include_related is false'
  );
});

test('searchMemories with include_related augments results with related summaries', async () => {
  // Save a "context" memory that will NOT appear in the search results (unique term).
  // Then save a "result" memory that links to it and will appear in results.
  // BFS enriches the result memory with the context memory's summary.
  const includeRelatedProject = `/test-include-related-${Date.now()}`;

  const contextMemId = await saveMemory({
    content: 'Underlying architecture uses an event-sourcing pattern for the order pipeline.',
    summary: 'Order pipeline uses event-sourcing',
    tags: ['architecture'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: includeRelatedProject,
    metadata: {},
  });

  await saveMemory({
    content: 'Optimized order processing throughput by batching database writes.',
    summary: 'Order processing throughput optimized',
    tags: ['performance'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: includeRelatedProject,
    metadata: {},
    related_ids: [{ id: contextMemId, relation_type: 'see-also' }],
  });

  // Wait for FTS index rebuild and back-linking
  await new Promise((r) => setTimeout(r, 1500));

  // Query targets only the performance memory; context memory won't match this query
  const { results } = await searchMemories({
    query: 'throughput optimized batching database writes',
    searchMode: 'fulltext',
    limit: 5,
    filters: { projectPath: includeRelatedProject },
    include_related: true,
    related_depth: 1,
  });
  assert.ok(results.length > 0, 'should return results');

  // The performance memory should appear and be augmented with the context memory summary
  const augmented = results.filter(
    (r) => Array.isArray(r.related) && r.related.length > 0
  );
  assert.ok(augmented.length > 0, 'result with related_ids not in result set should be augmented');

  // Each related summary should have the required fields
  for (const result of augmented) {
    for (const rel of result.related) {
      assert.ok(rel.id, 'related summary should have id');
      assert.ok(rel.summary, 'related summary should have summary');
      assert.ok(rel.relation_type, 'related summary should have relation_type');
      assert.ok(typeof rel.depth === 'number', 'related summary should have depth');
    }
  }
});

// ── filter safety ─────────────────────────────────────────────────────────────

test('getMemoryById returns null for non-UUID id', async () => {
  // validateUuid throws internally; getMemoryById catches and returns null
  const result = await getMemoryById('not-a-uuid');
  assert.equal(result, null, 'non-UUID id should return null');
});

test('sanitizeFilterValue rejects values with control characters', () => {
  assert.throws(
    () => sanitizeFilterValue('valid\x00injection', 'projectPath'),
    /control characters/,
    'null byte should be rejected'
  );
  assert.throws(
    () => sanitizeFilterValue('value\x1fwith-control', 'agentName'),
    /control characters/,
    'control character U+001F should be rejected'
  );
});

test('sanitizeFilterValue rejects projectPath exceeding max length', () => {
  const longPath = '/a'.repeat(2049);
  assert.throws(
    () => sanitizeFilterValue(longPath, 'projectPath'),
    /exceeds maximum length/,
    'projectPath over 4096 chars should be rejected'
  );
});

// ── stale memory filtering ────────────────────────────────────────────────────

const STALE_PROJECT = `/test-stale-${Date.now()}`;

let staleMemAId;
let staleMemBId;
let staleMemCId;
let staleMemDId;

test('freshly saved memory has is_stale === false', async () => {
  staleMemAId = await saveMemory({
    content: 'Initial approach to authentication using session tokens.',
    summary: 'Auth: session token approach',
    tags: ['auth'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: STALE_PROJECT,
    metadata: {},
  });
  assert.match(staleMemAId, /^[0-9a-f-]{36}$/);

  const mem = await getMemoryById(staleMemAId);
  assert.ok(mem, 'memory A should exist');
  assert.equal(mem.is_stale, false, 'freshly saved memory should have is_stale === false');
});

test('supersedes relation marks target memory as stale (fire-and-forget)', async () => {
  staleMemBId = await saveMemory({
    content: 'New authentication approach using JWT tokens instead of session tokens.',
    summary: 'Auth: JWT token approach (supersedes session tokens)',
    tags: ['auth'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: STALE_PROJECT,
    metadata: {},
    related_ids: [{ id: staleMemAId, relation_type: 'supersedes' }],
  });
  assert.match(staleMemBId, /^[0-9a-f-]{36}$/);

  // Wait for fire-and-forget stale marking to complete
  await new Promise((r) => setTimeout(r, 500));

  const memA = await getMemoryById(staleMemAId);
  assert.ok(memA, 'memory A should still exist');
  assert.equal(memA.is_stale, true, 'A should be marked stale after B supersedes it');
});

test('see-also relation does not change stale status of target', async () => {
  staleMemCId = await saveMemory({
    content: 'Related context about token expiry policies.',
    summary: 'Token expiry policy documentation',
    tags: ['auth', 'policy'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: STALE_PROJECT,
    metadata: {},
    related_ids: [{ id: staleMemAId, relation_type: 'see-also' }],
  });
  assert.match(staleMemCId, /^[0-9a-f-]{36}$/);

  // Wait for fire-and-forget back-link to complete
  await new Promise((r) => setTimeout(r, 500));

  const memA = await getMemoryById(staleMemAId);
  assert.ok(memA, 'memory A should still exist');
  assert.equal(memA.is_stale, true, 'see-also must not un-stale A — it should remain stale');
});

test('caused-by relation does not mark target as stale', async () => {
  staleMemDId = await saveMemory({
    content: 'Deployment incident caused by JWT migration rollout.',
    summary: 'Incident: JWT rollout deployment failure',
    tags: ['incident'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: STALE_PROJECT,
    metadata: {},
    related_ids: [{ id: staleMemBId, relation_type: 'caused-by' }],
  });
  assert.match(staleMemDId, /^[0-9a-f-]{36}$/);

  // Wait for fire-and-forget back-link to complete
  await new Promise((r) => setTimeout(r, 500));

  const memB = await getMemoryById(staleMemBId);
  assert.ok(memB, 'memory B should still exist');
  assert.equal(memB.is_stale, false, 'caused-by must not mark B as stale');
});

test('searchMemories without include_stale excludes stale memories', async () => {
  // Wait for FTS index rebuild
  await new Promise((r) => setTimeout(r, 1500));

  const { results } = await searchMemories({
    query: 'session token approach',
    searchMode: 'fulltext',
    limit: 10,
    filters: { projectPath: STALE_PROJECT },
  });

  const ids = results.map((r) => r.id);
  assert.ok(!ids.includes(staleMemAId), 'stale memory A should be excluded by default');
});

test('searchMemories with include_stale: true returns stale memories with is_stale flag', async () => {
  const { results } = await searchMemories({
    query: 'session token approach',
    searchMode: 'fulltext',
    limit: 10,
    filters: { projectPath: STALE_PROJECT },
    include_stale: true,
  });

  const memA = results.find((r) => r.id === staleMemAId);
  assert.ok(memA, 'stale memory A should be included when include_stale is true');
  assert.equal(memA.is_stale, true, 'stale memory should have is_stale === true');
});

test('getRecentMemories without include_stale excludes stale memories', async () => {
  const { memories } = await getRecentMemories(50, { projectPath: STALE_PROJECT });
  const ids = memories.map((m) => m.id);
  assert.ok(!ids.includes(staleMemAId), 'stale memory A should be excluded from recent by default');
});

test('getRecentMemories with include_stale: true returns stale memories', async () => {
  const { memories } = await getRecentMemories(50, {
    projectPath: STALE_PROJECT,
    include_stale: true,
  });
  const memA = memories.find((m) => m.id === staleMemAId);
  assert.ok(memA, 'stale memory A should appear when include_stale is true');
  assert.equal(memA.is_stale, true, 'stale memory should have is_stale === true');
});

test('getRecentMemories with no filters does not return stale memories (regression)', async () => {
  // Regression test for the absent-filters bug: no filters at all should still
  // exclude stale memories, not leak them through via a missing WHERE clause.
  const { memories } = await getRecentMemories(50);
  const ids = memories.map((m) => m.id);
  assert.ok(!ids.includes(staleMemAId), 'stale memory must not leak when no filters are passed');
});

test('getMemoryById always returns stale memory (explicit fetch is unfiltered)', async () => {
  const mem = await getMemoryById(staleMemAId);
  assert.ok(mem, 'getMemoryById should return a stale memory regardless of stale status');
  assert.equal(mem.id, staleMemAId);
  assert.equal(mem.is_stale, true, 'returned memory should carry is_stale === true');
});

test('getRelatedMemories skips stale nodes by default (BFS pruning)', async () => {
  // Chain: C (non-stale) -> A (stale). Traversing from C should skip A.
  const result = await getRelatedMemories(staleMemCId, 2);
  assert.ok(result.root, 'should return a root node for C');
  assert.equal(result.root.id, staleMemCId);

  const nodeIds = result.nodes.map((n) => n.id);
  assert.ok(!nodeIds.includes(staleMemAId), 'stale node A should be pruned from BFS by default');
});

test('getRelatedMemories with includeStale: true returns stale nodes with is_stale flag', async () => {
  const result = await getRelatedMemories(staleMemCId, 2, undefined, false, true);
  assert.ok(result.root, 'should return a root node for C');

  const nodeA = result.nodes.find((n) => n.id === staleMemAId);
  assert.ok(nodeA, 'stale node A should be included when includeStale is true');
  assert.equal(nodeA.is_stale, true, 'A node should carry is_stale === true');
});

test('stale subtree is unreachable from non-stale node unless includeStale is true', async () => {
  // A is stale and has a back-link to C (see-also). If A links to any node D,
  // D should also be unreachable unless includeStale is set. Here we verify
  // that BFS does not follow links beyond a stale node when includeStale is false.
  //
  // We use the existing chain: staleMemBId -> staleMemAId (superseded).
  // staleMemAId has a back-link to staleMemBId. A is stale, so B's links
  // to D via A are unreachable without includeStale.
  //
  // Create a dedicated chain: non-stale root -> stale intermediate -> leaf.
  const subtreeProject = `/test-stale-subtree-${Date.now()}`;

  const leafId = await saveMemory({
    content: 'Leaf node that should be unreachable through stale intermediate.',
    summary: 'Stale subtree leaf',
    tags: ['test'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: subtreeProject,
    metadata: {},
  });

  const staleIntermediateId = await saveMemory({
    content: 'Stale intermediate node in subtree test.',
    summary: 'Stale intermediate',
    tags: ['test'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: subtreeProject,
    metadata: {},
    related_ids: [{ id: leafId, relation_type: 'see-also' }],
  });

  const nonStaleRootId = await saveMemory({
    content: 'Non-stale root that links to a soon-to-be-stale intermediate.',
    summary: 'Non-stale root',
    tags: ['test'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: subtreeProject,
    metadata: {},
    related_ids: [{ id: staleIntermediateId, relation_type: 'see-also' }],
  });

  // Wait for FTS index rebuild and back-link fire-and-forget from the two saves above
  await new Promise((r) => setTimeout(r, 1500));

  // Supersede the intermediate to make it stale
  await saveMemory({
    content: 'Supersedes the intermediate node.',
    summary: 'Superseder of stale intermediate',
    tags: ['test'],
    agentName: 'test-agent',
    sessionId: 'test-session',
    projectPath: subtreeProject,
    metadata: {},
    related_ids: [{ id: staleIntermediateId, relation_type: 'supersedes' }],
  });

  // Wait for fire-and-forget stale marking to complete
  await new Promise((r) => setTimeout(r, 1500));

  // Verify intermediate is now stale
  const intermediate = await getMemoryById(staleIntermediateId);
  assert.equal(intermediate.is_stale, true, 'intermediate should be stale after being superseded');

  // BFS from non-stale root without includeStale: leaf should be unreachable
  const resultDefault = await getRelatedMemories(nonStaleRootId, 3);
  const defaultNodeIds = resultDefault.nodes.map((n) => n.id);
  assert.ok(!defaultNodeIds.includes(staleIntermediateId), 'stale intermediate should be pruned');
  assert.ok(!defaultNodeIds.includes(leafId), 'leaf behind stale node should be unreachable');

  // BFS with includeStale: true — both intermediate and leaf should be reachable
  const resultWithStale = await getRelatedMemories(nonStaleRootId, 3, undefined, false, true);
  const staleNodeIds = resultWithStale.nodes.map((n) => n.id);
  assert.ok(staleNodeIds.includes(staleIntermediateId), 'stale intermediate should appear with includeStale');
  assert.ok(staleNodeIds.includes(leafId), 'leaf behind stale node should be reachable with includeStale');
});
