import * as lancedb from '@lancedb/lancedb';
import * as arrow from 'apache-arrow';
import fs from 'fs';
import { config } from '../config.js';
import { getConnection } from './client.js';

const TABLE_NAME = 'memories';

const SCHEMA = new arrow.Schema([
  new arrow.Field('id', new arrow.Utf8(), false),
  new arrow.Field('content', new arrow.Utf8(), false),
  new arrow.Field('summary', new arrow.Utf8(), false),
  new arrow.Field(
    'embedding',
    new arrow.FixedSizeList(768, new arrow.Field('item', new arrow.Float32(), false)),
    true
  ),
  new arrow.Field(
    'tags',
    new arrow.List(new arrow.Field('item', new arrow.Utf8(), true)),
    false
  ),
  new arrow.Field('agentName', new arrow.Utf8(), false),
  new arrow.Field('sessionId', new arrow.Utf8(), false),
  new arrow.Field('projectPath', new arrow.Utf8(), false),
  new arrow.Field('createdAt', new arrow.Utf8(), false),
  new arrow.Field('metadata', new arrow.Utf8(), false),
  new arrow.Field('contentAndSummary', new arrow.Utf8(), false),
  new arrow.Field('cluster', new arrow.Utf8(), true),
  new arrow.Field('related_ids', new arrow.Utf8(), true),
]);

let _table: lancedb.Table | null = null;
let _ftsIndexed = false;
let _ftsRebuildTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Reset the cached table handle so the next getTable() call re-opens it.
 * Use this when serving requests in a separate process (e.g. the aibrain-ui
 * Express server) to pick up rows written by another process (the MCP server).
 */
export function resetTableCache(): void {
  _table = null;
}

export async function getTable(): Promise<lancedb.Table> {
  if (_table) return _table;

  // Ensure data directory exists
  fs.mkdirSync(config.AIBRAIN_DATA_DIR, { recursive: true });

  const conn = await getConnection();
  const tableNames = await conn.tableNames();

  if (!tableNames.includes(TABLE_NAME)) {
    _table = await conn.createEmptyTable(TABLE_NAME, SCHEMA, { existOk: true });
    console.error(`[aibrain] Created table: ${TABLE_NAME}`);

    // Btree indexes work on empty tables
    await _table.createIndex('agentName', { config: lancedb.Index.btree(), replace: true });
    await _table.createIndex('projectPath', { config: lancedb.Index.btree(), replace: true });
    await _table.createIndex('sessionId', { config: lancedb.Index.btree(), replace: true });
    await _table.createIndex('createdAt', { config: lancedb.Index.btree(), replace: true });
    await _table.createIndex('cluster', { config: lancedb.Index.btree(), replace: true });
    console.error('[aibrain] Scalar indexes created');
  } else {
    _table = await conn.openTable(TABLE_NAME);
    console.error(`[aibrain] Opened existing table: ${TABLE_NAME}`);

    // Check if FTS index already exists
    try {
      const indices = await _table.listIndices();
      _ftsIndexed = indices.some((i: any) => i.columns?.includes('contentAndSummary'));
    } catch {
      _ftsIndexed = false;
    }
  }

  return _table;
}

/**
 * Schedule an FTS index rebuild. Debounced so rapid successive writes
 * (e.g. bulk saves) result in a single rebuild rather than concurrent ones.
 */
export function rebuildFtsIndex(): void {
  if (_ftsRebuildTimer) clearTimeout(_ftsRebuildTimer);
  _ftsRebuildTimer = setTimeout(async () => {
    _ftsRebuildTimer = null;
    if (!_table) return;
    try {
      await _table.createIndex('contentAndSummary', {
        config: lancedb.Index.fts(),
        replace: true,
      });
      _ftsIndexed = true;
    } catch (err: any) {
      console.error('[aibrain] FTS index build error:', err.message);
      _ftsIndexed = false;
    }
  }, 500);
}

export function isFtsIndexed(): boolean {
  return _ftsIndexed;
}
