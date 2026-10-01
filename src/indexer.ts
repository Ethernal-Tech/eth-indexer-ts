import { sleep } from './common/utils';
import { LogEvent } from './common/data';
import { IndexerError, FatalIndexerError } from "./common/errors"
import { IEthClient } from './interfaces/ethClient';
import { IDatabase, ISubscriberDatabase } from './interfaces/database';
import { IIndexingStrategy, IndexerLoop } from './interfaces/indexing_strategy';
import { ILogger } from './interfaces/logger';
import { Config } from './config';
import { createIndexingStrategy } from './indexing_strategy';

export type NewLogCallback = (db: ISubscriberDatabase, logs: LogEvent[]) => Promise<void>;

export class Indexer {
  private readonly db: IDatabase;
  private readonly logger: ILogger;
  private readonly newLogCallback: NewLogCallback | undefined;
  private readonly strategy: IIndexingStrategy;
  private running = false;
  private abortController = new AbortController();

  constructor(
    config: Config,
    client: IEthClient,
    db: IDatabase,
    logger: ILogger,
    newLogCallback?: NewLogCallback,
    strategy?: IIndexingStrategy,
  ) {
    this.db = db;
    this.logger = logger;
    this.strategy = strategy ?? createIndexingStrategy(config, client, db, logger);
    this.newLogCallback = newLogCallback;
  }

  async init() {
    await this.db.initDb();
    await this.strategy.init();
  }

  stop() {
    this.running = false;
    // wakes both loops out of their wait instead of letting them finish it
    this.abortController.abort();
  }

  async start() {
    // Starting twice would swap the controller the running loops abort on,
    // leaving them waiting on a signal stop() no longer fires.
    if (this.running) {
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    return Promise.all(this.strategy.loops().map((loop) => this.executeLoop(loop)));
  }

  isRunning(): boolean {
    return this.running;
  }

  private async executeLoop(loop: IndexerLoop): Promise<void> {
    this.logger.info(`${loop.name} loop has been started`);
    while (this.running) {
      try {
        const newLogs = await loop.run(this.abortController.signal);
        if (newLogs?.length && !!this.newLogCallback) {
          await this.newLogCallback(this.db, newLogs);
        }
      } catch (e) {
        if (e instanceof FatalIndexerError) {
          this.logger.error({ err: e }, `Indexer fatal error (${loop.name}), stopping the indexer`);
          this.running = false;
          throw e;
        } else if (e instanceof IndexerError) {
          this.logger.error({ err: e }, `Indexer recoverable error (${loop.name})`);
        } else {
          this.logger.error({ err: e }, `Indexer other recoverable error (${loop.name})`);
        }
      }

      await sleep(loop.intervalMs, this.abortController.signal);
    }

    this.logger.info(`${loop.name} loop has been stopped`);
  }
}
