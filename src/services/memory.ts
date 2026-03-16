import { v4 as uuidv4 } from 'uuid';
import { getTable, rebuildFtsIndex, isFtsIndexed } from '../db/init.js';
import { generateEmbedding, isEmbeddingAvailable } from './embedding.js';
import type {
  MemoryDocument,
  MemorySearchResult,
  MemoryFilters,
  SearchOptions,
  ResultOptions,
  TagCount,
} from '../types.js';

// LanceDB applies a default limit of 10 to query().toArray() if no limit is set.
// Use this constant to fetch all rows when we need the full dataset.
const QUERY_ALL_LIMIT = 1_000_000;

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/;

function escapeStr(value: string): string {
  return value.replace(/'/g, "''");
}

function safeDate(value: string): string {
  if (!ISO8601_RE.test(value)) throw new Error(`Invalid date filter value: ${value}`);
  return value;
}

function buildWhereClause(filters: MemoryFilters | undefined): string {
  if (!filters) return '';
  const clauses: string[] = [];

  if (filters.agentName) {
    clauses.push(`\`agentName\` = '${escapeStr(filters.agentName)}'`);
  }
  if (filters.sessionId) {
    clauses.push(`\`sessionId\` = '${escapeStr(filters.sessionId)}'`);
  }
  if (filters.projectPath !== undefined) {
    clauses.push(`\`projectPath\` = '${escapeStr(filters.projectPath)}'`);
  }
  if (filters.since) {
    clauses.push(`\`createdAt\` >= '${safeDate(filters.since)}'`);
  }
  if (filters.until) {
    clauses.push(`\`createdAt\` <= '${safeDate(filters.until)}'`);
  }

  return clauses.join(' AND ');
}

function rowToResult(row: Record<string, any>, opts: ResultOptions = {}): MemorySearchResult {
  const { includeContent = false, contentMaxLength = 500 } = opts;

  const result: MemorySearchResult = {
    id: row.id,
    summary: row.summary,
    agentName: row.agentName,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
  };

  if (includeContent) {
    const raw: string = row.content ?? '';
    result.content =
      contentMaxLength > 0 && raw.length > contentMaxLength
        ? raw.slice(0, contentMaxLength) + '…'
        : raw;
  }

  const tags = row.tags;
  if (tags && tags.length > 0) result.tags = Array.from(tags);
  if (row.projectPath) result.projectPath = row.projectPath;

  if (row.metadata) {
    try {
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      if (meta && Object.keys(meta).length > 0) result.metadata = meta;
    } catch {}
  }

  if (row._distance !== undefined) result.score = 1 - row._distance;
  if (row._relevance_score !== undefined) result.score = row._relevance_score;
  if (row._score !== undefined) result.score = row._score;

  return result;
}

export async function saveMemory(
  input: Omit<MemoryDocument, 'id' | 'embedding' | 'createdAt' | 'contentAndSummary'>
): Promise<string> {
  const table = await getTable();
  const id = uuidv4();
  const embedding = await generateEmbedding(input.content + ' ' + input.summary);
  const contentAndSummary = input.content + ' ' + input.summary;

  const row = {
    id,
    content: input.content,
    summary: input.summary,
    // LanceDB rejects null for FixedSizeList columns; use zero vector when embedding unavailable
    embedding: embedding.length > 0 ? embedding : new Array(768).fill(0),
    tags: input.tags ?? [],
    agentName: input.agentName,
    sessionId: input.sessionId,
    projectPath: input.projectPath ?? '',
    createdAt: new Date().toISOString(),
    metadata: JSON.stringify(input.metadata ?? {}),
    contentAndSummary,
  };

  await table.add([row]);

  // Schedule a debounced FTS index rebuild so the new row becomes searchable
  rebuildFtsIndex();

  return id;
}

export async function searchMemories(options: SearchOptions): Promise<{
  results: MemorySearchResult[];
  totalFound: number;
  searchMode: string;
}> {
  const limit = Math.min(options.limit ?? 10, 50);
  const rrfK = options.rrfK ?? 60;
  let mode = options.searchMode ?? 'hybrid';

  if (mode === 'hybrid' || mode === 'vector') {
    const embeddingUp = await isEmbeddingAvailable();
    if (!embeddingUp) {
      console.error('[aibrain] Embedding unavailable, falling back to fulltext search');
      mode = 'fulltext';
    }
  }

  const ro = options.resultOptions;
  const where = buildWhereClause(options.filters);

  if (mode === 'fulltext') {
    return fulltextSearch(options.query, limit, where, options.filters, ro);
  }

  if (mode === 'vector') {
    const embedding = await generateEmbedding(options.query);
    if (embedding.length === 0) {
      return fulltextSearch(options.query, limit, where, options.filters, ro);
    }
    return vectorSearch(embedding, limit, where, options.filters, ro);
  }

  // Hybrid: run both, merge with RRF
  const embedding = await generateEmbedding(options.query);

  const [bm25Results, vectorResults] = await Promise.all([
    fulltextSearch(options.query, limit * 3, where, options.filters, ro),
    embedding.length > 0
      ? vectorSearch(embedding, limit * 3, where, options.filters, ro)
      : Promise.resolve({ results: [], totalFound: 0, searchMode: 'vector' }),
  ]);

  const scores = new Map<string, { score: number; doc: MemorySearchResult }>();

  bm25Results.results.forEach((doc, rank) => {
    const rrf = 1 / (rrfK + rank + 1);
    const existing = scores.get(doc.id);
    if (existing) {
      existing.score += rrf;
    } else {
      scores.set(doc.id, { score: rrf, doc });
    }
  });

  vectorResults.results.forEach((doc, rank) => {
    const rrf = 1 / (rrfK + rank + 1);
    const existing = scores.get(doc.id);
    if (existing) {
      existing.score += rrf;
    } else {
      scores.set(doc.id, { score: rrf, doc });
    }
  });

  const merged = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, doc }) => ({ ...doc, score }));

  return { results: merged, totalFound: scores.size, searchMode: 'hybrid' };
}

async function fulltextSearch(
  query: string,
  limit: number,
  where: string,
  filters?: MemoryFilters,
  opts?: ResultOptions
): Promise<{ results: MemorySearchResult[]; totalFound: number; searchMode: string }> {
  const table = await getTable();

  // Use FTS index if available
  if (isFtsIndexed()) {
    try {
      // Fetch more than needed; apply WHERE/tag filters in JS since LanceDB FTS
      // does not reliably honour .where() on indexed columns in all versions.
      const q = table.search(query, 'fts', 'contentAndSummary').limit(limit * 5);
      let rows = await q.toArray();
      if (where) rows = rows.filter((r: any) => matchesWhere(r, filters));
      rows = applyTagFilter(rows, filters?.tags);
      if (rows.length > 0) {
        return {
          results: rows.slice(0, limit).map((r: any) => rowToResult(r, opts)),
          totalFound: rows.length,
          searchMode: 'fulltext',
        };
      }
      // FTS returned 0 results after filtering — fall through to manual scan
    } catch (err: any) {
      console.error('[aibrain] FTS index search failed, falling back to scan:', err.message);
    }
  }

  // Fallback: manual scan with term matching
  return manualTextSearch(table, query, limit, where, filters, opts);
}

async function manualTextSearch(
  table: Awaited<ReturnType<typeof getTable>>,
  query: string,
  limit: number,
  where: string,
  filters?: MemoryFilters,
  opts?: ResultOptions
): Promise<{ results: MemorySearchResult[]; totalFound: number; searchMode: string }> {
  try {
    let q = table.query().limit(QUERY_ALL_LIMIT);
    if (where) q = q.where(where);
    const rows = await q.toArray();

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = rows
      .map((row: any) => {
        const text = (row.contentAndSummary ?? '').toLowerCase();
        const score = terms.reduce((acc: number, t: string) => acc + (text.includes(t) ? 1 : 0), 0);
        return { row, score };
      })
      .filter(({ score }: { score: number }) => score > 0)
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
      .slice(0, limit)
      .map(({ row }: { row: any }) => row);

    const filtered = applyTagFilter(scored, filters?.tags);
    return {
      results: filtered.map((r: any) => rowToResult(r, opts)),
      totalFound: filtered.length,
      searchMode: 'fulltext',
    };
  } catch (err: any) {
    console.error('[aibrain] Manual text search error:', err.message);
    return { results: [], totalFound: 0, searchMode: 'fulltext' };
  }
}

async function vectorSearch(
  embedding: number[],
  limit: number,
  where: string,
  filters?: MemoryFilters,
  opts?: ResultOptions
): Promise<{ results: MemorySearchResult[]; totalFound: number; searchMode: string }> {
  const table = await getTable();

  try {
    let q = table
      .vectorSearch(embedding)
      .column('embedding')
      .distanceType('cosine')
      .limit(limit);

    if (where) q = q.where(where);

    const rows = await q.toArray();
    const filtered = applyTagFilter(rows, filters?.tags);

    return {
      results: filtered.map((r: any) => rowToResult(r, opts)),
      totalFound: filtered.length,
      searchMode: 'vector',
    };
  } catch (err: any) {
    console.error('[aibrain] Vector search error:', err.message);
    return { results: [], totalFound: 0, searchMode: 'vector' };
  }
}

function matchesWhere(row: Record<string, any>, filters?: MemoryFilters): boolean {
  if (!filters) return true;
  if (filters.agentName && row.agentName !== filters.agentName) return false;
  if (filters.sessionId && row.sessionId !== filters.sessionId) return false;
  if (filters.projectPath !== undefined && row.projectPath !== filters.projectPath) return false;
  if (filters.since && row.createdAt < filters.since) return false;
  if (filters.until && row.createdAt > filters.until) return false;
  return true;
}

function applyTagFilter(rows: any[], tags?: string[]): any[] {
  if (!tags || tags.length === 0) return rows;
  return rows.filter((row) => {
    const rowTags: string[] = Array.from(row.tags ?? []);
    return tags.some((t) => rowTags.includes(t));
  });
}

export async function getRecentMemories(
  limit: number = 20,
  filters?: MemoryFilters,
  opts?: ResultOptions
): Promise<{ memories: MemorySearchResult[]; total: number }> {
  const table = await getTable();
  const safeLimit = Math.min(limit, 100);
  const where = buildWhereClause(filters);

  // Fetch all matching rows so where + tag filtering don't under-return.
  // LanceDB defaults to limit=10 without an explicit .limit() call.
  let q = table.query().limit(QUERY_ALL_LIMIT);
  if (where) q = q.where(where);

  const rows = await q.toArray();
  const filtered = applyTagFilter(rows, filters?.tags);

  // Sort by createdAt descending then apply limit
  filtered.sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));

  return {
    memories: filtered.slice(0, safeLimit).map((r: any) => rowToResult(r, opts)),
    total: filtered.length,
  };
}

export async function getMemoryById(id: string): Promise<MemorySearchResult | null> {
  const table = await getTable();

  try {
    const rows = await table
      .query()
      .where(`id = '${id.replace(/'/g, "''")}'`)  // `id` is lowercase, no quoting needed
      .limit(1)
      .toArray();

    if (rows.length === 0) return null;
    return rowToResult(rows[0], { includeContent: true });
  } catch {
    return null;
  }
}

export async function deleteMemory(
  id: string
): Promise<{ success: boolean; id?: string; error?: string }> {
  const table = await getTable();

  try {
    await table.delete(`id = '${id.replace(/'/g, "''")}'`);
    return { success: true, id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function listTags(
  agentName?: string,
  projectPath?: string,
  limit: number = 100
): Promise<{ tags: TagCount[]; total: number }> {
  const table = await getTable();
  const clauses: string[] = [];

  if (agentName) clauses.push(`\`agentName\` = '${agentName.replace(/'/g, "''")}'`);
  if (projectPath !== undefined)
    clauses.push(`\`projectPath\` = '${projectPath.replace(/'/g, "''")}'`);

  const where = clauses.join(' AND ');
  let q = table.query().limit(QUERY_ALL_LIMIT);
  if (where) q = q.where(where);

  const rows = await q.toArray();

  const counts = new Map<string, number>();
  for (const row of rows) {
    const tags: string[] = Array.from(row.tags ?? []);
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const tags: TagCount[] = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return { tags, total: tags.length };
}
