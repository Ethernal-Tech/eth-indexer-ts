import path from 'path';
import { LoggerOptions } from './interfaces/logger';
import { BlockNumberType } from './common/data';

function envInt(key: string, defaultValue: number): number {
  const val = Number(process.env[key]);
  return isNaN(val) ? defaultValue : val;
}

export class Config {
  private readonly rpcUrl: string;
  private readonly startBlock: number | undefined;
  private readonly confirmationBlocksCount: number;
  private readonly maxBatchSize: number;
  private readonly pullBlockIntervalMs: number;
  private readonly pullBlocksLoopIntervalMs: number;
  private readonly pullLogsIntervalMs: number;
  private readonly latestBlockStrategy: BlockNumberType;
  private readonly dbPath: string;
  private addresses: string[];
  private readonly topics: (string | string[])[] | undefined;
  private readonly logLevel: string;
  private readonly logPretty: boolean;
  private readonly logFile: string | undefined;
  private readonly logFileSize: string | undefined;
  private readonly logFileFrequency: 'daily' | 'hourly' | undefined;
  private readonly logFileMaxFiles: number;
  private readonly addressesBatchSize: number;

  constructor(params?: {
    rpcUrl: string;
    startBlockNumber: number | undefined;
    confirmationBlocksCount: number;
    maxBatchSize: number;
    pullBlockIntervalMs: number;
    pullBlocksLoopIntervalMs: number;
    pullLogsIntervalMs: number;
    latestBlockStrategy?: BlockNumberType;
    dbPath: string;
    addresses: string[];
    topics: (string | string[])[] | undefined;
    logLevel?: string;
    logPretty?: boolean;
    logFile?: string;
    logFileSize?: string;
    logFileFrequency?: 'daily' | 'hourly';
    logFileMaxFiles?: number;
    addressesBatchSize?: number;
  }) {
    if (!params) {
      let topics: (string | string[])[] | undefined = undefined;
      if (process.env.TOPICS) {
        topics = process.env.TOPICS.split(',').filter(x => !!x)
          .map((x) => {
            if (x.includes('|')) {
              return x.split('|').filter(x => !!x);
            }
            return [x];
          });
      }

      params = {
        addresses: process.env.ADDRESSES ? process.env.ADDRESSES.split(',').filter(x => !!x) : [],
        topics: topics,
        rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8545',
        startBlockNumber: envInt('START_BLOCK_NUMBER', 0),
        confirmationBlocksCount: envInt('CONFIRMATION_BLOCKS_COUNT', 12),
        maxBatchSize: envInt('MAX_BATCH_SIZE', 10),
        pullBlockIntervalMs: envInt('PULL_BLOCK_INTERVAL_MS', 3000),
        pullBlocksLoopIntervalMs: envInt('PULL_BLOCKS_LOOP_INTERVAL_MS', 500),
        pullLogsIntervalMs: envInt('PULL_LOGS_INTERVAL_MS', 4000),
        dbPath: process.env.DB_PATH || path.join(process.cwd(), 'indexer.db'),
        logLevel: process.env.LOG_LEVEL || 'info',
        logPretty: process.env.LOG_PRETTY === 'true',
        logFile: process.env.LOG_FILE || undefined,
        logFileSize: process.env.LOG_FILE_SIZE || undefined,
        logFileFrequency: (process.env.LOG_FILE_FREQUENCY as 'daily' | 'hourly') || undefined,
        logFileMaxFiles: envInt('LOG_FILE_MAX_FILES', 0),
        latestBlockStrategy: process.env.LATEST_BLOCK_STRATEGY as unknown as BlockNumberType,
        addressesBatchSize: envInt('ADDRESSES_BATCH_SIZE', 5),
      };
    }

    this.rpcUrl = params.rpcUrl;
    this.startBlock = params.startBlockNumber;
    this.confirmationBlocksCount = params.confirmationBlocksCount;
    this.maxBatchSize = params.maxBatchSize;
    this.pullBlockIntervalMs = params.pullBlockIntervalMs;
    this.pullBlocksLoopIntervalMs = params.pullBlocksLoopIntervalMs;
    this.pullLogsIntervalMs = params.pullLogsIntervalMs;
    this.dbPath = params.dbPath;
    this.addresses = params.addresses.map(a => a.toLowerCase());
    this.topics = params.topics;
    this.logLevel = params.logLevel ?? 'info';
    this.logPretty = params.logPretty ?? false;
    this.logFile = params.logFile;
    this.logFileSize = params.logFileSize;
    this.logFileFrequency = params.logFileFrequency;
    this.logFileMaxFiles = params.logFileMaxFiles ?? 0;
    this.latestBlockStrategy = params.latestBlockStrategy ?? BlockNumberType.Latest;
    this.addressesBatchSize = params.addressesBatchSize ?? 5;
  }

  getRpcUrl() { return this.rpcUrl; }
  getStartBlockNumber() { return this.startBlock; }
  getConfirmationBlocksCount() { return this.confirmationBlocksCount; }
  getMaxBatchSize() { return this.maxBatchSize; }
  getPullBlockIntervalMs() { return this.pullBlockIntervalMs; }
  getPullBlocksLoopIntervalMs() { return this.pullBlocksLoopIntervalMs; }
  getPullLogsIntervalMs() { return this.pullLogsIntervalMs; }
  getDbPath() { return this.dbPath; }
  getAddresses() { return this.addresses; }
  setAddresses(addresses: string[]) { this.addresses = addresses.map(a => a.toLowerCase()); }
  getTopics() { return this.topics; }
  getLogLevel() { return this.logLevel; }
  getLogPretty() { return this.logPretty; }
  getLoggerOptions(): LoggerOptions {
    return {
      level: this.logLevel,
      pretty: this.logPretty,
      file: this.logFile,
      fileSize: this.logFileSize,
      fileFrequency: this.logFileFrequency,
      fileMaxFiles: this.logFileMaxFiles,
    };
  }
  getLatestBlockStrategy() { return this.latestBlockStrategy; }
  getAddressesBatchSize() { return this.addressesBatchSize; }
}
