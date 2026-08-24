import 'dotenv/config';
import {
  BlockNumberType,
  Config,
  EthersEthClient,
  Indexer,
  PinoLogger,
  PinoLoggerOptions,
  SqliteDatabase,
} from '../src/index';
import { envEnum, envInt } from '../src/common/utils';
import path from 'node:path';
import { JsonRpcProvider } from 'ethers';

function getLoggerOptionsFromEnv(): PinoLoggerOptions {
  return {
    level: process.env.LOG_LEVEL || 'info',
    pretty: process.env.LOG_PRETTY === 'true',
    file: process.env.LOG_FILE || undefined,
    fileSize: process.env.LOG_FILE_SIZE || undefined,
    fileFrequency: (process.env.LOG_FILE_FREQUENCY as 'daily' | 'hourly') || undefined,
    fileMaxFiles: envInt('LOG_FILE_MAX_FILES', 0),
  }
}

function getOptionsFromEnv(): {
  rpcUrl: string,
  latestBlockStrategy: BlockNumberType,
  dbPath: string,
} {
  return {
    rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8545',
    latestBlockStrategy: envEnum('LATEST_BLOCK_STRATEGY', BlockNumberType, BlockNumberType.Latest),
    dbPath: process.env.DB_PATH || path.join(process.cwd(), 'indexer.db'),
  }
}

const config = new Config();
const logger = new PinoLogger(getLoggerOptionsFromEnv());

async function main() {
  const { rpcUrl, latestBlockStrategy, dbPath } = getOptionsFromEnv();
  const idx = new Indexer(
    config,
    new EthersEthClient(new JsonRpcProvider(rpcUrl), latestBlockStrategy),
    new SqliteDatabase(dbPath),
    logger,
    async (db) => {
      const lastId = (db.getLastProcessedEvent() ?? -1) + 1;
      const events = db.getEvents(lastId);
      if (events?.length) {
        logger.info({ events }, 'Unprocessed events');
        db.setLastProcessedEvent(events[events.length - 1].id);
      }
    },
  );

  logger.info({ config, rpcUrl, latestBlockStrategy, dbPath }, 'Starting indexer');

  await idx.init();
  await idx.start();
}

main().catch((e) => {
  logger.error({ err: e }, 'Fatal error');
  process.exit(1);
});
