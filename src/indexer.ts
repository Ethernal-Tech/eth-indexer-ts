import { sleep } from './common/utils';
import { LogEvent } from './common/data';
import { IndexerError, FatalIndexerError } from "./common/errors"
import { IEthClient } from './interfaces/ethClient';
import { IDatabase, ISubscriberDatabase } from './interfaces/database';
import { ILogger } from './interfaces/logger';
import { Config } from './config';
import { BlockContainer } from './block_container';
import { LogsProcessor } from './logs_processor';

export type NewLogCallback = (db: ISubscriberDatabase, logs: LogEvent[]) => Promise<void>;

export class Indexer {
  private readonly client: IEthClient;
  private readonly db: IDatabase;
  private readonly config: Config;
  private readonly logger: ILogger;
  private readonly newLogCallback: NewLogCallback | undefined;
  private readonly blocksContainer: BlockContainer;
  private readonly logsProcessor: LogsProcessor;
  private running = false;
  private abortController = new AbortController();

  constructor(
    config: Config,
    client: IEthClient,
    db: IDatabase,
    logger: ILogger,
    newLogCallback?: NewLogCallback,
  ) {
    this.config = config;
    this.client = client;
    this.db = db;
    this.logger = logger;
    this.blocksContainer = new BlockContainer(
      this.db,
      this.client,
      config.getConfirmationBlocksCount(),
      config.getStartBlockNumber(),
      config.getPullBlocksLoopIntervalMs(),
      logger);
    this.logsProcessor = new LogsProcessor(config, db, client, logger);
    this.newLogCallback = newLogCallback;
  }

  async init() {
    this.db.initDb();
    await this.blocksContainer.init();
  }

  stop() {
    this.running = false;
    // wakes both loops out of their wait instead of letting them finish it
    this.abortController.abort();
  }

  async start() {
    this.running = true;
    this.abortController = new AbortController();
    return Promise.all([this.blocksLoop(), this.logsLoop()]);
  }

  isRunning(): boolean {
    return this.running;
  }

  private async blocksLoop(): Promise<void> {
    return this.executeLoop('blocks', this.config.getPullBlockIntervalMs(), async () => {
      await this.blocksContainer.process(this.abortController.signal);
    });
  }

  private async logsLoop(): Promise<void> {
    return this.executeLoop('logs', this.config.getPullLogsIntervalMs(), async () => {
      const newLogs = await this.logsProcessor.process();
      if (newLogs?.length && !!this.newLogCallback) {
        await this.newLogCallback(this.db, newLogs);
      }
    });
  }

  private async executeLoop(
    name: string,
    waitTimeMs: number,
    action: () => Promise<void>
  ): Promise<void> {
    this.logger.info(`${name} loop has been started`);
    while (this.running) {
      try {
        await action();
      } catch (e) {
        if (e instanceof FatalIndexerError) {
          this.logger.error({ err: e }, `Indexer fatal error (${name}), stopping the indexer`);
          this.running = false;
          throw e;
        } else if (e instanceof IndexerError) {
          this.logger.error({ err: e }, `Indexer recoverable error (${name})`);
        } else {
          this.logger.error({ err: e }, `Indexer other recoverable error (${name})`);
        }
      }

      await sleep(waitTimeMs, this.abortController.signal);
    }

    this.logger.info(`${name} loop has been stopped`);
  }
}