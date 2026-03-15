import * as lancedb from '@lancedb/lancedb';
import { config } from '../config.js';

let _connection: lancedb.Connection | null = null;

export async function getConnection(): Promise<lancedb.Connection> {
  if (!_connection) {
    _connection = await lancedb.connect(config.AIBRAIN_DATA_DIR);
  }
  return _connection;
}
