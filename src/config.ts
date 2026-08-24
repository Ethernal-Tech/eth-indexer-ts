import { envInt } from './common/utils';

export class Config {
  private readonly startBlock: number | undefined;
  private readonly confirmationBlocksCount: number;
  private readonly maxBatchSize: number;
  private readonly pullBlockIntervalMs: number;
  private readonly pullBlocksLoopIntervalMs: number;
  private readonly pullLogsIntervalMs: number;
  private readonly topics: (string | string[])[] | undefined;
  private readonly addressesBatchSize: number;
  private addresses: string[];
  
  constructor(params?: {
    startBlockNumber: number | undefined;
    confirmationBlocksCount: number;
    maxBatchSize: number;
    pullBlockIntervalMs: number;
    pullBlocksLoopIntervalMs: number;
    pullLogsIntervalMs: number;
    addresses: string[];
    topics: (string | string[])[] | undefined;
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
        startBlockNumber: envInt('START_BLOCK_NUMBER', 0),
        confirmationBlocksCount: envInt('CONFIRMATION_BLOCKS_COUNT', 12),
        maxBatchSize: envInt('MAX_BATCH_SIZE', 10),
        pullBlockIntervalMs: envInt('PULL_BLOCK_INTERVAL_MS', 3000),
        pullBlocksLoopIntervalMs: envInt('PULL_BLOCKS_LOOP_INTERVAL_MS', 500),
        pullLogsIntervalMs: envInt('PULL_LOGS_INTERVAL_MS', 4000),
        addressesBatchSize: envInt('ADDRESSES_BATCH_SIZE', 5),
      };
    }

    this.startBlock = params.startBlockNumber;
    this.confirmationBlocksCount = params.confirmationBlocksCount;
    this.maxBatchSize = params.maxBatchSize;
    this.pullBlockIntervalMs = params.pullBlockIntervalMs;
    this.pullBlocksLoopIntervalMs = params.pullBlocksLoopIntervalMs;
    this.pullLogsIntervalMs = params.pullLogsIntervalMs;
    this.addresses = params.addresses.map(a => a.toLowerCase());
    this.topics = params.topics;
    this.addressesBatchSize = params.addressesBatchSize ?? 5;
  }

  getStartBlockNumber() { return this.startBlock; }
  getConfirmationBlocksCount() { return this.confirmationBlocksCount; }
  getMaxBatchSize() { return this.maxBatchSize; }
  getPullBlockIntervalMs() { return this.pullBlockIntervalMs; }
  getPullBlocksLoopIntervalMs() { return this.pullBlocksLoopIntervalMs; }
  getPullLogsIntervalMs() { return this.pullLogsIntervalMs; }
  getTopics() { return this.topics; }
  getAddressesBatchSize() { return this.addressesBatchSize; }
  getAddresses() { return this.addresses; }
  // Stored as given — unlike the constructor, which normalizes the raw env input.
  // Callers own the casing here: pass lower case to match lower-cased log addresses.
  setAddresses(addresses: string[]) { this.addresses = addresses; }
}
