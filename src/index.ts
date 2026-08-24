// ── Core classes ─────────────────────────────────────────────────────────────
export { Indexer } from './indexer';
export type { NewLogCallback } from './indexer';
export { Config } from './config';

// ── Default implementations ───────────────────────────────────────────────────
export { SqliteDatabase } from './db_sqllite';
export { EthersEthClient } from './ethClient_ethers';
export { PinoLogger, PinoLoggerOptions } from './logger_pino';

// ── Interfaces ────────────────────────────────────────────────────────────────
export type { ILogger } from './interfaces/logger';
export type {
  IDatabase,
  IBlocksDatabase,
  ILogsDatabase,
  ISubscriberDatabase,
} from './interfaces/database';
export type { IEthClient, IEthBlocksClient, IEthLogsClient } from './interfaces/ethClient';

// ── Data types ────────────────────────────────────────────────────────────────
export type { Block, LogEvent, ReceiptLog } from './common/data';
export { BlockNumberType } from './common/data';

// ── Errors ────────────────────────────────────────────────────────────────────
export { IndexerError, FatalIndexerError } from './common/errors';
