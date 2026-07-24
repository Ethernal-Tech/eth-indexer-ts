import { LogEvent } from "./common/data";
import { Config } from "./config";
import { IDatabase } from "./interfaces/database";
import { IEthLogsClient } from "./interfaces/ethClient";
import { ILogger } from "./interfaces/logger";

export class LogsProcessor {
  constructor(
    private readonly config: Config,
    private readonly db: IDatabase,
    private readonly client: IEthLogsClient,
    private readonly logger: ILogger,
  ) {
  }

  async process(): Promise<LogEvent[] | undefined> {
    const lastProccesedBlock = this.db.getLastProcessedBlock() ?? -1;
    const unprocessedBlocks = this.db.getBlocks(lastProccesedBlock + 1);
    if (!unprocessedBlocks.length) {
      return undefined;
    }

    const fromBlock = unprocessedBlocks[0].number;
    const toBlock = unprocessedBlocks[unprocessedBlocks.length - 1].number;
    const newLogs = [];

    for (let blockNum = fromBlock; blockNum <= toBlock; blockNum += this.config.getMaxBatchSize()) {
      const batchTo = Math.min(blockNum + this.config.getMaxBatchSize() - 1, toBlock);

      this.logger.info({ fromBlock: blockNum, toBlock: batchTo }, 'Processing logs for blocks');

      const addressBatches = this.chunkAddresses(
        this.config.getAddresses(), this.config.getAddressesBatchSize());

      const batchResults = await Promise.all(
        addressBatches.map(async (addresses) => {
          const logs = await this.client.getLogs(blockNum, batchTo, addresses, this.config.getTopics());
          return logs.map((log) => ({
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            txIndex: log.txIndex,
            txHash: log.txHash,          
            address: log.address,
            topics: log.topics,
            data: log.data,
          } as LogEvent))
        }),
      );

      const dbLogs = batchResults.flat();
      // save to db
      this.db.insertEventAndSetLastProcessedBlock(dbLogs, batchTo);

      newLogs.push(...dbLogs);
    }

    return newLogs;
  }

  private chunkAddresses(addresses: string[], size: number): (string[] | undefined)[] {
    // No addresses => one address-less query (filter by topics only).
    if (!addresses.length) {
      return [undefined];
    }

    const step = Math.max(1, size);
    const batches: string[][] = [];
    for (let i = 0; i < addresses.length; i += step) {
      batches.push(addresses.slice(i, i + step));
    }

    return batches;
  }
}