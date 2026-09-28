import { Block, LogEvent } from '../common/data'

export interface IBlocksDatabase {
  getLastBlock(): Promise<Block | null>;
  insertBlock(block: Block): Promise<void>;
}

export interface ISubscriberDatabase {
  getLastProcessedEvent(): Promise<number | null>;
  setLastProcessedEvent(number: number): Promise<void>;
  getEvents(fromId: number, limit?: number): Promise<LogEvent[]>;
}

export interface ILogsDatabase {
  getBlocks(fromBlockNumber: number, limit?: number): Promise<Block[]>;
  getLastProcessedBlock(): Promise<number | null>;
  insertEventAndSetLastProcessedBlock(events: LogEvent[], blockNumber: number): Promise<void>;
}

export interface IDatabase extends ISubscriberDatabase, IBlocksDatabase, ILogsDatabase {
  initDb(): Promise<void>;
}
