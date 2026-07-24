import SqlLiteDb, { Database } from 'better-sqlite3'
import { Block, LogEvent } from './common/data';
import { IDatabase } from './interfaces/database'

export class SqliteDatabase implements IDatabase {
  private readonly dbPath: string;
  private db: Database;
  private txInsertEventsAndSetLastProcessedBlock: (events: LogEvent[], blockNumber: number) => void;

  constructor(path: string) {
    this.dbPath = path;
    this.db = new SqlLiteDb(this.dbPath);
    this.txInsertEventsAndSetLastProcessedBlock = (_, _a) => { throw new Error('Transaction not initialized'); };
  }

  initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        number INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        parent_hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tx_hashes TEXT
      );

      CREATE TABLE IF NOT EXISTS last_processed_block (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        number INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS last_processed_event (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        number INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        block_number INTEGER NOT NULL,
        tx_hash STRING NOT NULL,
        address TEXT NOT NULL,
        topics TEXT NOT NULL,
        data TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        tx_index INTEGER NOT NULL
      );
    `);

    const setLastProcessedBlockStmt = this.db.prepare(
      'INSERT OR REPLACE INTO last_processed_block(id, number) VALUES(1, ?)');
    const insertEventStmt = this.db.prepare(
      'INSERT OR IGNORE INTO events(block_number, tx_hash, address, topics, data, log_index, tx_index) VALUES (?,?,?,?,?,?,?)');
    this.txInsertEventsAndSetLastProcessedBlock = this.db.transaction((events: LogEvent[], blockNumber: number) => {
      for (const e of events) {
        insertEventStmt.run(e.blockNumber, e.txHash, e.address, e.topics.join(','), e.data, e.logIndex, e.txIndex);
      }

      setLastProcessedBlockStmt.run(blockNumber);
    });
  }

  insertBlock(block: Block) {
    const txHashes = block.txHashes?.length ? block.txHashes.join(',') : null;
    const stmt = this.db.prepare('INSERT INTO blocks(number, hash, parent_hash, timestamp, tx_hashes) VALUES(?,?,?,?,?)');
    stmt.run(block.number, block.hash, block.parentHash, block.timestamp, txHashes);
  }

  getLastBlock(): Block | null {
    const row = this.db.prepare('SELECT * FROM blocks ORDER BY number DESC LIMIT 1').get();
    return this.rowToBlock(row);
  }

  getBlocks(fromBlockNumber: number, limit?: number): Block[] {
    let rows: unknown[];
    if (limit) {
      const stmt = this.db.prepare('SELECT * FROM blocks WHERE number >= ? ORDER BY number ASC LIMIT ?');
      rows = stmt.all(fromBlockNumber, limit);
    } else {
      const stmt = this.db.prepare('SELECT * FROM blocks WHERE number >= ? ORDER BY number ASC');
      rows = stmt.all(fromBlockNumber);
    }
    return rows.map((row: any) => this.rowToBlock(row)!);
  }

  getLastProcessedEvent(): number | null {
    const row = this.db.prepare('SELECT number FROM last_processed_event WHERE id = 1').get();
    return row ? (row as any).number : null;
  }

  setLastProcessedEvent(number: number) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO last_processed_event(id, number) VALUES(1, ?)');
    stmt.run(number);
  }

  getLastProcessedBlock(): number | null {
    const row = this.db.prepare('SELECT number FROM last_processed_block WHERE id = 1').get();
    return row ? (row as any).number : null;
  }

  insertEventAndSetLastProcessedBlock(events: LogEvent[], blockNumber: number) {
    return this.txInsertEventsAndSetLastProcessedBlock(events, blockNumber);
  }

  getEvents(fromId: number, limit?: number): LogEvent[] {
    let rows: unknown[];
    if (limit) {
      const stmt = this.db.prepare('SELECT * FROM events WHERE id >= ? ORDER BY id LIMIT ?');
      rows = stmt.all(fromId, limit);
    } else {
      const stmt = this.db.prepare('SELECT * FROM events WHERE id >= ? ORDER BY id');
      rows = stmt.all(fromId);
    }

    return rows.map((row: any) => this.rowToEvent(row)!);
  }

  private rowToBlock(row: any): Block | null {
    if (!row) return null;
    return {
      number: row.number,
      hash: row.hash,
      parentHash: row.parent_hash,
      timestamp: row.timestamp,
      txHashes: row.tx_hashes?.split(',') || [],
    };
  }

  private rowToEvent(row: any): LogEvent | null {
    if (!row) return null;
    return {
      id: row.id,
      blockNumber: row.block_number,
      txHash: row.tx_hash,
      address: row.address,
      topics: row.topics.split(','),
      data: row.data,
      logIndex: row.log_index,
      txIndex: row.tx_index,
    };
  }
}
