import { IndexingMode } from './common/data';
import { BlockContainer } from './block_container';
import { Config } from './config';
import { ConfirmedRangeProcessor } from './confirmed_range_processor';
import { IDatabase } from './interfaces/database';
import { IEthClient } from './interfaces/ethClient';
import { IIndexingStrategy, IndexerLoop } from './interfaces/indexing_strategy';
import { ILogger } from './interfaces/logger';
import { LogsProcessor } from './logs_processor';

/** Confirms every block through BlockContainer, then fetches logs for the confirmed ones. */
export class BlockTrackingStrategy implements IIndexingStrategy {
  private readonly blocksContainer: BlockContainer;
  private readonly logsProcessor: LogsProcessor;

  constructor(
    private readonly config: Config,
    client: IEthClient,
    db: IDatabase,
    logger: ILogger,
  ) {
    this.blocksContainer = new BlockContainer(
      db,
      client,
      config.getConfirmationBlocksCount(),
      config.getStartBlockNumber(),
      config.getPullBlocksLoopIntervalMs(),
      logger);
    this.logsProcessor = new LogsProcessor(config, db, client, logger);
  }

  async init(): Promise<void> {
    await this.blocksContainer.init();
  }

  loops(): IndexerLoop[] {
    return [
      {
        name: 'blocks',
        intervalMs: this.config.getPullBlockIntervalMs(),
        run: async (signal) => {
          await this.blocksContainer.process(signal);
          return undefined;
        },
      },
      {
        name: 'logs',
        intervalMs: this.config.getPullLogsIntervalMs(),
        run: (signal) => this.logsProcessor.process(signal),
      },
    ];
  }
}

/** Fetches logs straight up to head minus the confirmation count; see ConfirmedRangeProcessor. */
export class ConfirmedRangeStrategy implements IIndexingStrategy {
  private readonly processor: ConfirmedRangeProcessor;

  constructor(
    private readonly config: Config,
    client: IEthClient,
    db: IDatabase,
    logger: ILogger,
  ) {
    this.processor = new ConfirmedRangeProcessor(
      config, db, client, new LogsProcessor(config, db, client, logger));
  }

  async init(): Promise<void> {
  }

  loops(): IndexerLoop[] {
    return [
      {
        name: 'logs',
        intervalMs: this.config.getPullLogsIntervalMs(),
        run: (signal) => this.processor.process(signal),
      },
    ];
  }
}

export function createIndexingStrategy(
  config: Config,
  client: IEthClient,
  db: IDatabase,
  logger: ILogger,
): IIndexingStrategy {
  if (config.getIndexingMode() === IndexingMode.ConfirmedRange) {
    return new ConfirmedRangeStrategy(config, client, db, logger);
  }
  return new BlockTrackingStrategy(config, client, db, logger);
}
