import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfirmedRangeProcessor } from '../src/confirmed_range_processor';
import { LogsProcessor } from '../src/logs_processor';
import { Block, LogEvent, ReceiptLog } from '../src/common/data';
import { Config } from '../src/config';
import { IDatabase } from '../src/interfaces/database';
import { ILogger } from '../src/interfaces/logger';

const noopLogger: ILogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

// ── helpers ──────────────────────────────────────────────────────────────────

function makeBlock(number: number, hash = `hash${number}`): Block {
  return { number, hash, parentHash: `hash${number - 1}`, timestamp: 0, txHashes: [] };
}

function makeReceiptLog(blockNumber: number): ReceiptLog {
  return { address: '0xAAA', topics: ['0xTOPIC'], data: '0x', txHash: '0xff', blockNumber, logIndex: 0, txIndex: 0 };
}

function makeConfig(overrides?: {
  startBlockNumber?: number;
  confirmationBlocksCount?: number;
  maxBatchSize?: number;
}): Config {
  return new Config({
    startBlockNumber: overrides?.startBlockNumber ?? 0,
    confirmationBlocksCount: overrides?.confirmationBlocksCount ?? 5,
    maxBatchSize: overrides?.maxBatchSize ?? 10,
    pullBlockIntervalMs: 0,
    pullBlocksLoopIntervalMs: 0,
    pullLogsIntervalMs: 0,
    addresses: ['0xAAA'],
    topics: undefined,
  });
}

class MockDB implements IDatabase {
  private blocks: Block[] = [];
  private events: LogEvent[] = [];
  private lastProcessedBlock: number | null = null;
  private lastProcessedEvent: number | null = null;

  async initDb() {}
  async insertBlock(block: Block) {
    this.blocks = this.blocks.filter((b) => b.number !== block.number);
    this.blocks.push(block);
  }
  async getLastBlock() {
    return this.blocks.reduce<Block | null>((max, b) => (!max || b.number > max.number ? b : max), null);
  }
  async getBlocks(from: number, limit?: number) {
    const found = this.blocks.filter((b) => b.number >= from).sort((a, b) => a.number - b.number);
    return limit ? found.slice(0, limit) : found;
  }
  async getLastProcessedBlock() { return this.lastProcessedBlock; }
  async insertEventAndSetLastProcessedBlock(events: LogEvent[], blockNumber: number) {
    this.events.push(...events);
    this.lastProcessedBlock = blockNumber;
  }
  async getLastProcessedEvent() { return this.lastProcessedEvent; }
  async setLastProcessedEvent(n: number) { this.lastProcessedEvent = n; }
  async getEvents(fromId: number) { return this.events.slice(fromId); }

  getAllEvents() { return this.events; }
}

class MockClient {
  head: Block | null = null;
  blocks: Record<number, Block> = {};

  /** Blocks 0..height with predictable hashes; the head is the highest one. */
  setChain(height: number) {
    for (let i = 0; i <= height; i++) this.blocks[i] = makeBlock(i);
    this.head = this.blocks[height];
  }

  getLatestBlock = vi.fn(async () => this.head);
  getLatestBlockNumber = vi.fn(async () => this.head?.number ?? null);
  getBlockByNumber = vi.fn(async (n: number) => this.blocks[n] ?? null);
  getLogs = vi.fn(async (_from: number, _to: number, _addresses?: string[]): Promise<ReceiptLog[]> => []);
}

function makeProcessor(db: MockDB, client: MockClient, config = makeConfig()) {
  return new ConfirmedRangeProcessor(
    config, db, client, new LogsProcessor(config, db, client, noopLogger));
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('ConfirmedRangeProcessor', () => {
  let db: MockDB;
  let client: MockClient;

  beforeEach(() => {
    db = new MockDB();
    client = new MockClient();
  });

  it('returns undefined when the node reports no head', async () => {
    const result = await makeProcessor(db, client).process();
    expect(result).toBeUndefined();
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it('processes up to head minus the confirmation count', async () => {
    client.setChain(20);
    const result = await makeProcessor(db, client).process();

    expect(client.getLogs).toHaveBeenCalledTimes(2);
    expect(client.getLogs).toHaveBeenNthCalledWith(1, 0, 9, expect.any(Array), undefined);
    expect(client.getLogs).toHaveBeenNthCalledWith(2, 10, 15, expect.any(Array), undefined);
    expect(await db.getLastProcessedBlock()).toBe(15);
    expect((await db.getLastBlock())?.number).toBe(15);
    expect(result).toEqual([]);
  });

  it('starts from the configured start block', async () => {
    client.setChain(20);
    await makeProcessor(db, client, makeConfig({ startBlockNumber: 8 })).process();
    expect(client.getLogs).toHaveBeenCalledTimes(1);
    expect(client.getLogs).toHaveBeenCalledWith(8, 15, expect.any(Array), undefined);
  });

  it('resumes right after the cursor', async () => {
    client.setChain(20);
    await db.insertEventAndSetLastProcessedBlock([], 12);
    await makeProcessor(db, client).process();
    expect(client.getLogs).toHaveBeenCalledTimes(1);
    expect(client.getLogs).toHaveBeenCalledWith(13, 15, expect.any(Array), undefined);
  });

  it('does nothing while the safe head is not past the cursor', async () => {
    client.setChain(20);
    await db.insertEventAndSetLastProcessedBlock([], 15);
    await db.insertBlock(makeBlock(15));
    const result = await makeProcessor(db, client).process();

    expect(result).toBeUndefined();
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it('never targets a height below the start', async () => {
    client.setChain(3);
    const result = await makeProcessor(db, client).process();
    expect(result).toBeUndefined();
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it('returns the stored logs', async () => {
    client.setChain(20);
    client.getLogs.mockResolvedValueOnce([makeReceiptLog(3)]);
    const result = await makeProcessor(db, client).process();

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ blockNumber: 3, address: '0xAAA', topics: ['0xTOPIC'] });
    expect(db.getAllEvents()).toHaveLength(1);
  });

  it('stores a placeholder block carrying the last processed number', async () => {
    client.setChain(20);
    await makeProcessor(db, client).process();

    expect(await db.getLastBlock()).toEqual({
      number: 15, hash: '', parentHash: '', timestamp: 0, txHashes: [],
    });
    expect(client.getBlockByNumber).not.toHaveBeenCalled();
    expect(client.getLatestBlock).not.toHaveBeenCalled();
  });

  it('advances the block cursor after every batch, not only at the end', async () => {
    client.setChain(20);
    const cursors: (number | undefined)[] = [];
    client.getLogs.mockImplementation(async () => {
      cursors.push((await db.getLastBlock())?.number);
      return [];
    });

    await makeProcessor(db, client).process();

    expect(client.getLogs).toHaveBeenCalledTimes(2);
    expect(cursors).toEqual([undefined, 9]);
    expect((await db.getLastBlock())?.number).toBe(15);
  });

  it('catches the block cursor up when it fell behind the log cursor', async () => {
    client.setChain(17);
    await db.insertEventAndSetLastProcessedBlock([], 12);

    const result = await makeProcessor(db, client).process();

    expect(result).toBeUndefined();
    expect(client.getLogs).not.toHaveBeenCalled();
    expect((await db.getLastBlock())?.number).toBe(12);
  });

  it('places the cursor at the last batch that committed when aborted part way', async () => {
    client.setChain(30);
    const controller = new AbortController();
    client.getLogs.mockImplementationOnce(async () => {
      controller.abort();
      return [];
    });

    await makeProcessor(db, client, makeConfig({ maxBatchSize: 5 })).process(controller.signal);

    expect(client.getLogs).toHaveBeenCalledTimes(1);
    expect(await db.getLastProcessedBlock()).toBe(4);
    expect((await db.getLastBlock())?.number).toBe(4);
  });
});
