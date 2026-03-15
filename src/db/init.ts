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
]);

let _table: lancedb.Table | null = null;
let _ftsIndexed = false;

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
 * (Re)build the FTS index. Called after writes so new rows are searchable.
 * Safe to call concurrently — subsequent calls are no-ops until the next write.
 */
export async function rebuildFtsIndex(): Promise<void> {
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
}

export function isFtsIndexed(): boolean {
  return _ftsIndexed;
}
