import { v4 as uuidv4 } from 'uuid';
import { getTable, rebuildFtsIndex, isFtsIndexed } from '../db/init.js';
import { generateEmbedding, isEmbeddingAvailable } from './embedding.js';
import { config } from '../config.js';
import type {
  MemoryDocument,
  MemorySearchResult,
  MemorySearchResultWithRelated,
  RelatedMemorySummary,
  MemoryFilters,
  SearchOptions,
  ResultOptions,
  TagCount,
  RelatedId,
} from '../types.js';

// LanceDB applies a default limit of 10 to query().toArray() if no limit is set.
// Use this constant to fetch all rows when we need the full dataset.
const QUERY_ALL_LIMIT = 1_000_000;

// -- Input validation constants ------------------------------------------------

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLUSTER_RE = /^[a-z0-9-]{1,64}$/;

// Control characters (U+0000-U+001F, U+007F) are never valid in filter strings.
// Null bytes and common SQL comment sequences are explicitly caught here even
// though LanceDB's SQL engine may not be exploitable via them -- defence in depth.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

const MAX_FILTER_LENGTH: Record<string, number> = {
  agentName: 256,
  sessionId: 256,
  projectPath: 4096,
  cluster: 64,
};

// -- Validation helpers --------------------------------------------------------

/**
 * Centralised filter-value validator. Validates value according to
 * per-field rules and throws a descriptive Error on any violation.
 *
 * Returns the original (unescaped) string so callers can apply SQL escaping
 * separately and explicitly. Keeping validation and escaping as distinct steps
 * makes the intent of each operation clear.
 */
export function sanitizeFilterValue(value: string, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Filter field '${fieldName}' must be a string`);
  }

  const maxLen = MAX_FILTER_LENGTH[fieldName] ?? 1024;
  if (value.length > maxLen) {
    throw new Error(
      `Filter field '${fieldName}' exceeds maximum length of ${maxLen} characters`
    );
  }

  if (CONTROL_CHARS_RE.test(value)) {
    throw new Error(
      `Filter field '${fieldName}' contains invalid control characters`
    );
  }

  // cluster requires an extra strict allowlist pattern
  if (fieldName === 'cluster' && !CLUSTER_RE.test(value)) {
    throw new Error(
      `Filter field 'cluster' must match /^[a-z0-9-]{1,64}$/, got: ${JSON.stringify(value)}`
    );
  }

  return value;
}

/**
 * Validates that id is a well-formed UUID (v1-v5, any variant).
 * Throws if the format is invalid so callers never embed unvalidated IDs
 * in WHERE clauses.
 */
function validateUuid(id: string): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error(`Invalid id: expected a UUID, got ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * Escapes single quotes for embedding a string literal inside a SQL WHERE
 * clause. Must only be called on values that have already been validated by
 * sanitizeFilterValue or validateUuid.
 */
function escapeSql(value: string): string {
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
    const v = sanitizeFilterValue(filters.agentName, 'agentName');
    clauses.push(`\`agentName\` = '${escapeSql(v)}'`);
  }
  if (filters.sessionId) {
    const v = sanitizeFilterValue(filters.sessionId, 'sessionId');
    clauses.push(`\`sessionId\` = '${escapeSql(v)}'`);
  }
  if (filters.projectPath !== undefined) {
    const v = sanitizeFilterValue(filters.projectPath, 'projectPath');
    clauses.push(`\`projectPath\` = '${escapeSql(v)}'`);
  }
  if (filters.since) {
    clauses.push(`\`createdAt\` >= '${safeDate(filters.since)}'`);
  }
  if (filters.until) {
    clauses.push(`\`createdAt\` <= '${safeDate(filters.until)}'`);
  }
  if (filters.cluster !== undefined) {
    const v = sanitizeFilterValue(filters.cluster, 'cluster');
    clauses.push(`\`cluster\` = '${escapeSql(v)}'`);
  }

  if (!filters.include_stale) {
    clauses.push(`\`is_stale\` = false`);
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
        ? raw.slice(0, contentMaxLength) + '...'
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

  if (row.cluster) result.cluster = row.cluster;

  result.is_stale = row.is_stale ?? false;

  if (row.related_ids) {
    try {
      const parsed: RelatedId[] =
        typeof row.related_ids === 'string' ? JSON.parse(row.related_ids) : row.related_ids;
      if (Array.isArray(parsed) && parsed.length > 0) result.related_ids = parsed;
    } catch {}
  }

  if (row._distance !== undefined) result.score = 1 - row._distance;
  if (row._relevance_score !== undefined) result.score = row._relevance_score;
  if (row._score !== undefined) result.score = row._score;

  return result;
}

export async function saveMemory(
  input: Omit<MemoryDocument, 'id' | 'embedding' | 'createdAt' | 'contentAndSummary' | 'cluster' | 'related_ids'> & {
    cluster?: string;
    // Callers pass structured RelatedId objects; the service serializes to JSON for storage.
    related_ids?: RelatedId[];
  }
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
    cluster: input.cluster ?? '',
    related_ids: input.related_ids ? JSON.stringify(input.related_ids) : '[]',
    is_stale: false,
  };

  await table.add([row]);

  // Create reverse (back) links on every referenced memory.
  // Fire-and-forget so back-linking failures do not block the caller.
  if (input.related_ids && input.related_ids.length > 0) {
    Promise.all(
      input.related_ids.map((link) =>
        appendRelatedIdIfAbsent(link.id, {
          id,
          relation_type: reverseRelationType(link.relation_type),
        })
      )
    ).catch((err) => {
      console.error('[aibrain] Back-linking error:', err);
    });
  }

  // Fire-and-forget — do not block the save response
  autoLink(id, embedding).catch((err) =>
    console.error('[autoLink] failed silently:', err)
  );

  // Schedule a debounced FTS index rebuild so the new row becomes searchable
  rebuildFtsIndex();

  return id;
}

const REVERSE_RELATION: Record<string, RelatedId['relation_type']> = {
  supersedes: 'see-also',
  'caused-by': 'see-also',
  'see-also': 'see-also',
  'follow-up': 'see-also',
};

function reverseRelationType(relationType: string): RelatedId['relation_type'] {
  return REVERSE_RELATION[relationType] ?? 'see-also';
}

/**
 * Runs a vector similarity search against existing memories and creates
 * bidirectional `similar` links for any candidates above the configured
 * threshold. Called fire-and-forget after every save so it never adds
 * latency to the caller.
 *
 * Manual links always take precedence: if any link of any relation type
 * already exists between the two IDs, the auto-link is skipped.
 */
async function autoLink(newId: string, embedding: number[]): Promise<void> {
  const AUTO_LINK_THRESHOLD = config.AIBRAIN_AUTO_LINK_THRESHOLD;
  const AUTO_LINK_LIMIT = config.AIBRAIN_AUTO_LINK_LIMIT;

  // Zero vectors indicate embedding is unavailable — skip auto-linking.
  if (embedding.every((v) => v === 0)) return;

  const table = await getTable();

  const rows = await table
    .vectorSearch(embedding)
    .column('embedding')
    .distanceType('cosine')
    .limit(AUTO_LINK_LIMIT + 1)
    .toArray();

  const candidates = rows.filter((row: any) => row.id !== newId);

  await Promise.all(
    candidates.map(async (row: any) => {
      const score = 1 - (row._distance ?? 1);
      if (score < AUTO_LINK_THRESHOLD) return;

      // Skip if any link already exists from the new memory to this candidate.
      // appendRelatedIdIfAbsent handles the target side; we check the source side
      // to respect manual links supplied at save time.
      const sourceRows = await table
        .query()
        .where(`id = '${escapeSql(validateUuid(newId))}'`)
        .limit(1)
        .toArray();

      if (sourceRows.length === 0) return;

      let sourceLinks: RelatedId[] = [];
      try {
        sourceLinks =
          typeof sourceRows[0].related_ids === 'string'
            ? JSON.parse(sourceRows[0].related_ids)
            : (sourceRows[0].related_ids ?? []);
      } catch {
        sourceLinks = [];
      }

      if (sourceLinks.some((r) => r.id === row.id)) return;

      // Create bidirectional similar links.
      await Promise.all([
        appendRelatedIdIfAbsent(newId, { id: row.id, relation_type: 'similar' }),
        appendRelatedIdIfAbsent(row.id, { id: newId, relation_type: 'similar' }),
      ]);
    })
  );
}

/**
 * Appends a back-link to the target memory if no link between the two IDs
 * already exists (regardless of relation type). Skips silently if the target
 * memory has been deleted or if a link already exists.
 *
 * Exported so Issue #9 (auto-linking) can reuse this without duplicating logic.
 */
export async function appendRelatedIdIfAbsent(
  targetId: string,
  link: RelatedId
): Promise<void> {
  const safeTargetId = validateUuid(targetId);
  validateUuid(link.id);

  const table = await getTable();

  const rows = await table
    .query()
    .where(`id = '${escapeSql(safeTargetId)}'`)
    .limit(1)
    .toArray();

  // Target memory has been deleted -- skip silently.
  if (rows.length === 0) return;

  const targetRow = rows[0];

  let existing: RelatedId[] = [];
  try {
    existing =
      typeof targetRow.related_ids === 'string'
        ? JSON.parse(targetRow.related_ids)
        : (targetRow.related_ids ?? []);
  } catch {
    existing = [];
  }

  // Duplicate check: any existing link between these two IDs, regardless of type.
  if (existing.some((r) => r.id === link.id)) return;

  const updated = JSON.stringify([...existing, link]);
  await table.update({
    values: { related_ids: updated },
    where: `id = '${escapeSql(safeTargetId)}'`,
  });
}

/**
 * BFS over related_ids links up to `maxDepth` hops, returning summary-only
 * entries for each discovered neighbour.  IDs already in `seedIds` (the search
 * result set itself) are excluded so we never return a result as its own related
 * memory.
 */
async function fetchRelatedBfs(
  seedIds: Set<string>,
  rootRelatedIds: RelatedId[],
  maxDepth: number
): Promise<RelatedMemorySummary[]> {
  const visited = new Set<string>(seedIds);
  const summaries: RelatedMemorySummary[] = [];

  // Queue entries: { id, relation_type from parent, depth }
  type QueueEntry = { id: string; relation_type: RelatedId['relation_type']; depth: number };
  let queue: QueueEntry[] = rootRelatedIds
    .filter((r) => !visited.has(r.id))
    .map((r) => ({ id: r.id, relation_type: r.relation_type, depth: 1 }));

  while (queue.length > 0) {
    // Process all nodes at the current frontier in parallel
    const batch = queue;
    queue = [];

    const fetched = await Promise.all(
      batch.map(async (entry) => {
        if (visited.has(entry.id)) return null;
        visited.add(entry.id);
        const mem = await getMemoryById(entry.id);
        return mem ? { mem, entry } : null;
      })
    );

    for (const item of fetched) {
      if (!item) continue;
      const { mem, entry } = item;
      summaries.push({
        id: mem.id,
        summary: mem.summary,
        relation_type: entry.relation_type,
        depth: entry.depth,
      });

      // Expand one more hop if depth budget allows
      if (entry.depth < maxDepth && mem.related_ids) {
        for (const next of mem.related_ids) {
          if (!visited.has(next.id)) {
            queue.push({ id: next.id, relation_type: next.relation_type, depth: entry.depth + 1 });
          }
        }
      }
    }
  }

  return summaries;
}

export async function searchMemories(options: SearchOptions): Promise<{
  results: MemorySearchResultWithRelated[];
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

  // Apply AIBRAIN_DEFAULT_CLUSTER as a pre-filter when no explicit cluster is provided.
  // Callers that pass filters.cluster always win; those that don't get the env default.
  let filters = options.filters;
  if (config.AIBRAIN_DEFAULT_CLUSTER && filters?.cluster === undefined) {
    filters = { ...filters, cluster: config.AIBRAIN_DEFAULT_CLUSTER };
  }

  const where = buildWhereClause(filters);

  let response: { results: MemorySearchResult[]; totalFound: number; searchMode: string };

  if (mode === 'fulltext') {
    response = await fulltextSearch(options.query, limit, where, filters, ro);
  } else if (mode === 'vector') {
    const embedding = await generateEmbedding(options.query);
    response = embedding.length === 0
      ? await fulltextSearch(options.query, limit, where, filters, ro)
      : await vectorSearch(embedding, limit, where, filters, ro);
  } else {
    // Hybrid: run both, merge with RRF
    const embedding = await generateEmbedding(options.query);

    const [bm25Results, vectorResults] = await Promise.all([
      fulltextSearch(options.query, limit * 3, where, filters, ro),
      embedding.length > 0
        ? vectorSearch(embedding, limit * 3, where, filters, ro)
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

    response = { results: merged, totalFound: scores.size, searchMode: 'hybrid' };
  }

  if (!options.include_related) {
    return response;
  }

  // Enrich each result with related memories fetched via BFS (ID-based, not vector).
  const maxDepth = Math.min(options.related_depth ?? 1, 2);
  const seedIds = new Set(response.results.map((r) => r.id));

  const enriched: MemorySearchResultWithRelated[] = await Promise.all(
    response.results.map(async (result) => {
      const rootLinks = result.related_ids ?? [];
      if (rootLinks.length === 0) return result;
      const related = await fetchRelatedBfs(seedIds, rootLinks, maxDepth);
      return related.length > 0 ? { ...result, related } : result;
    })
  );

  return { ...response, results: enriched };
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
      // FTS returned 0 results after filtering -- fall through to manual scan
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
  if (filters.cluster !== undefined && row.cluster !== filters.cluster) return false;
  if (!filters.include_stale && row.is_stale === true) return false;
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
  try {
    // Validate before constructing the WHERE clause -- UUIDs are safe to interpolate
    // directly once validated (they contain only hex digits and hyphens), but we
    // still apply escapeSql for belt-and-suspenders consistency.
    const safeId = validateUuid(id);
    const table = await getTable();

    const rows = await table
      .query()
      .where(`id = '${escapeSql(safeId)}'`)
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
  let safeId: string;
  try {
    safeId = validateUuid(id);
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  const table = await getTable();

  try {
    await table.delete(`id = '${escapeSql(safeId)}'`);
    return { success: true, id: safeId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function getRelatedMemories(
  rootId: string,
  depth: number,
  relationTypes?: string[],
  includeContent: boolean = false
): Promise<{
  root: { id: string; summary: string; tags: string[] } | null;
  nodes: Array<{
    id: string;
    summary: string;
    content?: string;
    relation_type: string;
    depth: number;
    tags: string[];
    createdAt: string;
  }>;
  error?: string;
}> {
  const root = await getMemoryById(rootId);
  if (!root) {
    return { root: null, nodes: [], error: `Memory not found: ${rootId}` };
  }

  const rootNode = {
    id: root.id,
    summary: root.summary,
    tags: root.tags ?? [],
  };

  const visited = new Set<string>([rootId]);
  const nodes: Array<{
    id: string;
    summary: string;
    content?: string;
    relation_type: string;
    depth: number;
    tags: string[];
    createdAt: string;
  }> = [];

  // BFS queue entries: [memoryId, currentDepth]
  type QueueEntry = { id: string; relation_type: string; currentDepth: number };
  const queue: QueueEntry[] = [];

  // Seed the queue from the root's related_ids
  const rootRelatedIds: RelatedId[] = root.related_ids ?? [];
  for (const link of rootRelatedIds) {
    if (relationTypes && !relationTypes.includes(link.relation_type)) continue;
    if (!visited.has(link.id)) {
      queue.push({ id: link.id, relation_type: link.relation_type, currentDepth: 1 });
    }
  }

  while (queue.length > 0) {
    const { id, relation_type, currentDepth } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const memory = await getMemoryById(id);
    if (!memory) continue;

    const node: (typeof nodes)[number] = {
      id: memory.id,
      summary: memory.summary,
      relation_type,
      depth: currentDepth,
      tags: memory.tags ?? [],
      createdAt: memory.createdAt,
    };

    if (includeContent) {
      node.content = memory.content;
    }

    nodes.push(node);

    // Only follow links if we haven't reached the depth limit
    if (currentDepth < depth) {
      const linkedIds: RelatedId[] = memory.related_ids ?? [];
      for (const link of linkedIds) {
        if (relationTypes && !relationTypes.includes(link.relation_type)) continue;
        if (!visited.has(link.id)) {
          queue.push({
            id: link.id,
            relation_type: link.relation_type,
            currentDepth: currentDepth + 1,
          });
        }
      }
    }
  }

  return { root: rootNode, nodes };
}

export async function listTags(
  agentName?: string,
  projectPath?: string,
  limit: number = 100
): Promise<{ tags: TagCount[]; total: number }> {
  const table = await getTable();
  const clauses: string[] = [];

  if (agentName) {
    const v = sanitizeFilterValue(agentName, 'agentName');
    clauses.push(`\`agentName\` = '${escapeSql(v)}'`);
  }
  if (projectPath !== undefined) {
    const v = sanitizeFilterValue(projectPath, 'projectPath');
    clauses.push(`\`projectPath\` = '${escapeSql(v)}'`);
  }

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
