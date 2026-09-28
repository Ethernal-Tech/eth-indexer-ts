import { LogEvent } from './common/data';
import { Config } from './config';
import { IDatabase } from './interfaces/database';
import { IEthClient } from './interfaces/ethClient';
import { LogsProcessor } from './logs_processor';

/**
 * Fetches logs straight up to head minus the confirmation count, without
 * tracking blocks. Only the head is read from the node; reorgs deeper than the
 * confirmation window are not detected in this mode.
 */
export class ConfirmedRangeProcessor {
  constructor(
    private readonly config: Config,
    private readonly db: IDatabase,
    private readonly client: IEthClient,
    private readonly logsProcessor: LogsProcessor,
  ) {
  }

  async process(signal?: AbortSignal): Promise<LogEvent[] | undefined> {
    const head = await this.client.getLatestBlock();
    if (!head) {
      return undefined;
    }

    const toBlock = head.number - this.config.getConfirmationBlocksCount();
    const lastProcessed = (await this.db.getLastProcessedBlock()) ?? -1;
    const fromBlock = Math.max(lastProcessed + 1, this.config.getStartBlockNumber() ?? 0);
    if (toBlock < fromBlock) {
      return undefined;
    }

    const { logs, processedTo } = await this.logsProcessor.processRange(fromBlock, toBlock, signal);
    if (processedTo !== null) {
      // Placeholder row: consumers read the last block's number as the confirmed cursor.
      await this.db.insertBlock({
        number: processedTo, hash: '', parentHash: '', timestamp: 0, txHashes: [],
      });
    }

    return logs;
  }
}
