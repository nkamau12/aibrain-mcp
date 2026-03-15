/**
 * aiBrain performance benchmark: ArangoDB vs LanceDB
 * Imports both service layers directly — no MCP/HTTP overhead.
 *
 * Usage:
 *   node bench.mjs [--count=30] [--warmup=5]
 */

import * as arango from '/Users/nkamau/Development/aiBrain/dist/services/memory.js';
import * as lance from '/Users/nkamau/Development/aibrain-mcp/dist/services/memory.js';

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace('--', '').split('=')).filter((a) => a.length === 2)
);
const COUNT = parseInt(args.count ?? '30');
const WARMUP = parseInt(args.warmup ?? '5');
const BENCH_PROJECT = `/bench-${Date.now()}`;

// ─── Corpus ──────────────────────────────────────────────────────────────────
const CORPUS = [
  'The agent discovered that the authentication middleware was missing CSRF protection on POST endpoints.',
  'Refactored the database connection pooling logic to reuse connections across requests for better performance.',
  'Fixed a race condition in the job queue where two workers could claim the same task simultaneously.',
  'Added retry logic with exponential backoff for all external API calls to improve resilience.',
  'The deployment pipeline was updated to run integration tests against a staging database before production.',
  'Investigated memory leak in the image processing service — root cause was unclosed streams in error paths.',
  'Implemented Redis-based session caching to reduce database load during peak traffic hours.',
  'The search indexer was rewritten to use incremental updates instead of full rebuilds every hour.',
  'Added comprehensive logging to the payment processor to aid debugging of failed transaction flows.',
  'Migrated the legacy REST endpoints to GraphQL resolvers as part of the API modernization project.',
  'Discovered that the vector index was rebuilding on every server restart due to missing persistence config.',
  'Optimized the embedding pipeline by batching requests to the Ollama server instead of calling one by one.',
  'Set up a nightly cron job to vacuum and reindex the memory database to prevent unbounded disk growth.',
  'The TypeScript compiler errors were caused by a version mismatch between the SDK and the type definitions.',
  'Configured the LanceDB table schema with FixedSizeList for embeddings to ensure vector search compatibility.',
];

const QUERIES = [
  'authentication security vulnerability',
  'database performance optimization',
  'memory leak debugging',
  'deployment pipeline testing',
  'vector search embedding',
  'caching strategy Redis',
  'race condition concurrency fix',
  'API retry resilience',
];

function sample(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function time(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

// ─── Benchmark runner ────────────────────────────────────────────────────────
async function bench(svc) {
  const results = {};
  const ids = [];

  // ── save (includes embedding generation) ─────────────────────────────────
  process.stderr.write('  save ');
  const saveTimes = [];
  for (let i = 0; i < COUNT; i++) {
    const content = `${sample(CORPUS)} (bench item ${i})`;
    const ms = await time(() =>
      svc.saveMemory({
        content,
        summary: content.slice(0, 80),
        tags: ['bench', i % 2 === 0 ? 'even' : 'odd'],
        agentName: 'bench-agent',
        sessionId: 'bench-session',
        projectPath: BENCH_PROJECT,
        metadata: { index: i },
      }).then((id) => ids.push(id))
    );
    saveTimes.push(ms);
    if (i % 5 === 4) process.stderr.write('.');
  }
  results.save = stats(saveTimes);
  process.stderr.write(' done\n');

  // Wait for LanceDB FTS index rebuild
  await new Promise((r) => setTimeout(r, 3000));

  // ── fulltext ──────────────────────────────────────────────────────────────
  process.stderr.write('  fulltext ');
  const ftsTimes = [];
  for (let i = 0; i < COUNT; i++) {
    const ms = await time(() =>
      svc.searchMemories({ query: sample(QUERIES), searchMode: 'fulltext', limit: 10, filters: { projectPath: BENCH_PROJECT } })
    );
    ftsTimes.push(ms);
    if (i % 5 === 4) process.stderr.write('.');
  }
  results.fulltext = stats(ftsTimes);
  process.stderr.write(' done\n');

  // ── vector ────────────────────────────────────────────────────────────────
  process.stderr.write('  vector   ');
  const vecTimes = [];
  for (let i = 0; i < COUNT; i++) {
    const ms = await time(() =>
      svc.searchMemories({ query: sample(QUERIES), searchMode: 'vector', limit: 10, filters: { projectPath: BENCH_PROJECT } })
    );
    vecTimes.push(ms);
    if (i % 5 === 4) process.stderr.write('.');
  }
  results.vector = stats(vecTimes);
  process.stderr.write(' done\n');

  // ── hybrid ────────────────────────────────────────────────────────────────
  process.stderr.write('  hybrid   ');
  const hybTimes = [];
  for (let i = 0; i < COUNT; i++) {
    const ms = await time(() =>
      svc.searchMemories({ query: sample(QUERIES), searchMode: 'hybrid', limit: 10, filters: { projectPath: BENCH_PROJECT } })
    );
    hybTimes.push(ms);
    if (i % 5 === 4) process.stderr.write('.');
  }
  results.hybrid = stats(hybTimes);
  process.stderr.write(' done\n');

  // ── getRecent ─────────────────────────────────────────────────────────────
  process.stderr.write('  getRecent');
  const recentTimes = [];
  for (let i = 0; i < COUNT; i++) {
    const ms = await time(() =>
      svc.getRecentMemories(20, { projectPath: BENCH_PROJECT })
    );
    recentTimes.push(ms);
    if (i % 5 === 4) process.stderr.write('.');
  }
  results.getRecent = stats(recentTimes);
  process.stderr.write(' done\n');

  // ── getById ───────────────────────────────────────────────────────────────
  process.stderr.write('  getById  ');
  const getTimes = [];
  for (let i = 0; i < COUNT; i++) {
    const ms = await time(() => svc.getMemoryById(ids[i % ids.length]));
    getTimes.push(ms);
    if (i % 5 === 4) process.stderr.write('.');
  }
  results.getById = stats(getTimes);
  process.stderr.write(' done\n');

  // ── delete ────────────────────────────────────────────────────────────────
  process.stderr.write('  delete   ');
  const delTimes = [];
  for (const id of ids) {
    const ms = await time(() => svc.deleteMemory(id));
    delTimes.push(ms);
  }
  results.delete = stats(delTimes);
  process.stderr.write(' done\n');

  return results;
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    mean: sum / times.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    n: times.length,
  };
}

// ─── Output ──────────────────────────────────────────────────────────────────
const W = 76;
const COL = { op: 12, db: 10, val: 8 };

function pad(s, n, right = false) {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

function fmt(n) { return n.toFixed(1); }

function winner(a, l) {
  const ratio = a / l;
  if (Math.abs(ratio - 1) < 0.1) return '  ~tie';
  if (ratio > 1) return `  Lance ${ratio.toFixed(1)}x faster ↑`;
  return `  Arango ${(1 / ratio).toFixed(1)}x faster ↑`;
}

function printResults(aR, lR) {
  const ops = Object.keys(aR);
  const line = '─'.repeat(W);
  const dline = '═'.repeat(W);

  console.log('\n' + dline);
  console.log(`  aiBrain Benchmark: ArangoDB vs LanceDB  (n=${COUNT}, Ollama: nomic-embed-text)`);
  console.log(dline);
  console.log(
    pad('Operation', COL.op) +
    pad('DB', COL.db) +
    pad('Mean ms', COL.val, true) +
    pad('Median', COL.val, true) +
    pad('p95', COL.val, true) +
    pad('Min', COL.val, true) +
    pad('Max', COL.val, true) +
    '  Winner'
  );
  console.log(line);

  for (const op of ops) {
    const a = aR[op];
    const l = lR[op];
    const w = winner(a.mean, l.mean);

    console.log(
      pad(op, COL.op) +
      pad('ArangoDB', COL.db) +
      pad(fmt(a.mean), COL.val, true) +
      pad(fmt(a.median), COL.val, true) +
      pad(fmt(a.p95), COL.val, true) +
      pad(fmt(a.min), COL.val, true) +
      pad(fmt(a.max), COL.val, true)
    );
    console.log(
      pad('', COL.op) +
      pad('LanceDB', COL.db) +
      pad(fmt(l.mean), COL.val, true) +
      pad(fmt(l.median), COL.val, true) +
      pad(fmt(l.p95), COL.val, true) +
      pad(fmt(l.min), COL.val, true) +
      pad(fmt(l.max), COL.val, true) +
      w
    );
    console.log(line);
  }

  console.log('\n  Notes:');
  console.log('  • save times include Ollama embedding generation (shared cost for both DBs)');
  console.log('  • hybrid = BM25 fulltext + vector search merged via RRF');
  console.log('  • LanceDB FTS uses inverted index; fallback to manual scan on empty index');
  console.log('  • ArangoDB runs as a warm in-memory server; LanceDB reads directly from disk');
  console.log(dline + '\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────
console.error(`\naiBrain benchmark  count=${COUNT}  warmup=${WARMUP}  ollama=enabled`);
console.error(`Bench project: ${BENCH_PROJECT}\n`);

// Warmup — prime Ollama embedding cache
console.error(`Warming up Ollama (${WARMUP} embeddings)…`);
for (let i = 0; i < WARMUP; i++) {
  await arango.saveMemory({ content: `warmup item ${i} ${sample(CORPUS)}`, summary: 'warmup', tags: ['warmup'], agentName: 'bench', sessionId: 'warmup', projectPath: '/warmup', metadata: {} });
  await lance.saveMemory({ content: `warmup item ${i} ${sample(CORPUS)}`, summary: 'warmup', tags: ['warmup'], agentName: 'bench', sessionId: 'warmup', projectPath: '/warmup', metadata: {} });
}
// clean warmup data
const wA = await arango.getRecentMemories(50, { projectPath: '/warmup' });
for (const m of wA.memories) await arango.deleteMemory(m.id).catch(() => {});
const wL = await lance.getRecentMemories(50, { projectPath: '/warmup' });
for (const m of wL.memories) await lance.deleteMemory(m.id).catch(() => {});

console.error('\nArangoDB…');
const arangoResults = await bench(arango);

console.error('\nLanceDB…');
const lanceResults = await bench(lance);

printResults(arangoResults, lanceResults);

console.error('Cleaning up…');
// Any leftover data already deleted inside bench()
console.error('Done.\n');
