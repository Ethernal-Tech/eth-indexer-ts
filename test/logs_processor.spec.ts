import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LogsProcessor } from '../src/logs_processor';
import { Block, LogEvent, ReceiptLog } from '../src/common/data';
import { Config } from '../src/config';
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

function makeBlock(number: number): Block {
  return { number, hash: `hash${number}`, parentHash: `hash${number - 1}`, timestamp: 0, txHashes: [] };
}

function makeReceiptLog(
  address: string,
  topic0: string,
  txHash = '0xff',
  blockNumber = 1,
  logIndex = 0,
  txIndex = 0,
): ReceiptLog {
  return { address, topics: [topic0], data: '0x', txHash, blockNumber, logIndex, txIndex };
}

function makeConfig(overrides?: {
  maxBatchSize?: number;
  addresses?: string[];
  topics?: (string | string[])[] | undefined;
  addressesBatchSize?: number;
}): Config {
  return new Config({
    rpcUrl: 'http://localhost:8545',
    startBlockNumber: 0,
    confirmationBlocksCount: 12,
    maxBatchSize: overrides?.maxBatchSize ?? 10,
    pullBlockIntervalMs: 0,
    pullBlocksLoopIntervalMs: 0,
    pullLogsIntervalMs: 0,
    dbPath: ':memory:',
    addresses: overrides?.addresses ?? ['0xAAA'],
    topics: overrides?.topics,
    addressesBatchSize: overrides?.addressesBatchSize,
  });
}

// ── mocks ────────────────────────────────────────────────────────────────────

class MockDB {
  private blocks: Block[] = [];
  private events: LogEvent[] = [];
  private lastProcessedBlock: number | null = null;
  private lastProcessedEvent: number | null = null;

  insertBlock(block: Block) { this.blocks.push(block); }
  getLastBlock() { return this.blocks.at(-1) ?? null; }
  getBlocks(fromBlockNumber: number, limit?: number): Block[] {
    const filtered = this.blocks.filter(b => b.number >= fromBlockNumber);
    return limit !== undefined ? filtered.slice(0, limit) : filtered;
  }
  getLastProcessedBlock() { return this.lastProcessedBlock; }
  insertEventAndSetLastProcessedBlock(events: LogEvent[], blockNumber: number) {
    this.events.push(...events);
    this.lastProcessedBlock = blockNumber;
  }
  getEvents(fromId: number, limit?: number) { return this.events.slice(fromId); }
  getLastProcessedEvent() { return this.lastProcessedEvent; }
  setLastProcessedEvent(n: number) { this.lastProcessedEvent = n; }
  initDb() {}

  getAllEvents() { return this.events; }
}

class MockLogsClient {
  getLogs = vi.fn((
    _from: number,
    _to: number,
    _addresses?: string[],
    _topics?: (string | string[])[],
  ): Promise<ReceiptLog[]> => Promise.resolve([]));
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('LogsProcessor', () => {
  let db: MockDB;
  let client: MockLogsClient;

  beforeEach(() => {
    db = new MockDB();
    client = new MockLogsClient();
  });

  // ── no-op when nothing to process ─────────────────────────────────────────

  it('returns undefined when there are no unprocessed blocks', async () => {
    const processor = new LogsProcessor(makeConfig(), db as any, client, noopLogger);
    const result = await processor.process();
    expect(result).toBeUndefined();
  });

  it('returns undefined when all blocks were already processed', async () => {
    db.insertBlock(makeBlock(1));
    db.insertBlock(makeBlock(2));
    db.insertEventAndSetLastProcessedBlock([], 2); // mark block 2 as last processed
    const processor = new LogsProcessor(makeConfig(), db as any, client, noopLogger);
    const result = await processor.process();
    expect(result).toBeUndefined();
  });

  // ── single batch ───────────────────────────────────────────────────────────

  it('processes a single batch and returns logs', async () => {
    db.insertBlock(makeBlock(1));
    db.insertBlock(makeBlock(2));
    client.getLogs = vi.fn(() =>
      Promise.resolve([makeReceiptLog('0xAAA', '0xTOPIC1', '0xffcc', 10)])
    );
    const processor = new LogsProcessor(makeConfig({ maxBatchSize: 10 }), db as any, client, noopLogger);
    const result = await processor.process();
    expect(result).toHaveLength(1);
    expect(result![0].address).toBe('0xAAA'); // stored as-is from ReceiptLog, not lowercased
    expect(result![0].txHash).toBe('0xffcc');
    expect(result![0].blockNumber).toBe(10);
  });

  it('calls getLogs with correct address array, fromBlock and toBlock', async () => {
    db.insertBlock(makeBlock(5));
    db.insertBlock(makeBlock(6));
    const processor = new LogsProcessor(makeConfig({ maxBatchSize: 10, addresses: ['0xBBB'] }), db as any, client, noopLogger);
    await processor.process();
    expect(client.getLogs).toHaveBeenCalledWith(5, 6, ['0xbbb'], undefined);
  });

  it('saves logs and updates last processed block after each batch', async () => {
    db.insertBlock(makeBlock(1));
    const mockLog = makeReceiptLog('0xAAA', '0xTOPIC1');
    client.getLogs = vi.fn(() => Promise.resolve([mockLog]));
    const processor = new LogsProcessor(makeConfig(), db as any, client, noopLogger);
    await processor.process();
    expect(db.getAllEvents()).toHaveLength(1);
    expect(db.getLastProcessedBlock()).toBe(1);
  });

  // ── multi-batch ────────────────────────────────────────────────────────────

  it('splits into multiple batches when block range exceeds maxBatchSize', async () => {
    // blocks 1–5, maxBatchSize=2 → batches [1-2], [3-4], [5-5]
    for (let i = 1; i <= 5; i++) db.insertBlock(makeBlock(i));
    const processor = new LogsProcessor(makeConfig({ maxBatchSize: 2 }), db as any, client, noopLogger);
    await processor.process();
    expect(client.getLogs).toHaveBeenCalledTimes(3);
    expect(client.getLogs).toHaveBeenNthCalledWith(1, 1, 2, expect.any(Array), undefined);
    expect(client.getLogs).toHaveBeenNthCalledWith(2, 3, 4, expect.any(Array), undefined);
    expect(client.getLogs).toHaveBeenNthCalledWith(3, 5, 5, expect.any(Array), undefined);
  });

  it('accumulates logs from all batches', async () => {
    for (let i = 1; i <= 4; i++) db.insertBlock(makeBlock(i));
    client.getLogs = vi.fn(() =>
      Promise.resolve([makeReceiptLog('0xAAA', '0xTOPIC1')])
    );
    const processor = new LogsProcessor(makeConfig({ maxBatchSize: 2 }), db as any, client, noopLogger);
    const result = await processor.process();
    // 2 batches × 1 log each = 2
    expect(result).toHaveLength(2);
  });

  it('last processed block is set to batchTo of the final batch', async () => {
    for (let i = 1; i <= 5; i++) db.insertBlock(makeBlock(i));
    const processor = new LogsProcessor(makeConfig({ maxBatchSize: 2 }), db as any, client, noopLogger);
    await processor.process();
    expect(db.getLastProcessedBlock()).toBe(5);
  });

  // ── starts from lastProcessedBlock + 1 ────────────────────────────────────

  it('only processes blocks after lastProcessedBlock', async () => {
    for (let i = 1; i <= 4; i++) db.insertBlock(makeBlock(i));
    db.insertEventAndSetLastProcessedBlock([], 2); // blocks 1-2 already processed
    const processor = new LogsProcessor(makeConfig({ maxBatchSize: 10 }), db as any, client, noopLogger);
    await processor.process();
    expect(client.getLogs).toHaveBeenCalledWith(3, 4, expect.any(Array), undefined);
    expect(client.getLogs).toHaveBeenCalledTimes(1);
  });

  // ── topic filtering ────────────────────────────────────────────────────────

  it('passes all logs through when no topics are configured', async () => {
    db.insertBlock(makeBlock(1));
    client.getLogs = vi.fn(() =>
      Promise.resolve([
        makeReceiptLog('0xAAA', '0xTOPIC_ANY_1'),
        makeReceiptLog('0xAAA', '0xTOPIC_ANY_2'),
      ])
    );
    const processor = new LogsProcessor(makeConfig({ topics: undefined }), db as any, client, noopLogger);
    const result = await processor.process();
    expect(result).toHaveLength(2);
  });

  it('passes all logs through when topics array is empty', async () => {
    db.insertBlock(makeBlock(1));
    client.getLogs = vi.fn(() =>
      Promise.resolve([makeReceiptLog('0xAAA', '0xTOPIC_ANY')])
    );
    const processor = new LogsProcessor(makeConfig({ topics: [] }), db as any, client, noopLogger);
    const result = await processor.process();
    expect(result).toHaveLength(1);
  });

  it('forwards configured topics to getLogs', async () => {
    db.insertBlock(makeBlock(1));
    const processor = new LogsProcessor(
      makeConfig({ addresses: ['0xAAA'], topics: [['0xMATCH']] }),
      db as any,
      client,
      noopLogger
    );
    await processor.process();
    expect(client.getLogs).toHaveBeenCalledWith(1, 1, ['0xaaa'], [['0xMATCH']]);
  });

  it('does not filter locally - the node applies the topic filter', async () => {
    db.insertBlock(makeBlock(1));
    client.getLogs = vi.fn(() =>
      Promise.resolve([
        makeReceiptLog('0xAAA', '0xMATCH'),
        makeReceiptLog('0xAAA', '0xNO_MATCH'),
      ])
    );
    const processor = new LogsProcessor(
      makeConfig({ addresses: ['0xAAA'], topics: [['0xMATCH']] }),
      db as any,
      client,
      noopLogger
    );
    const result = await processor.process();
    // whatever the client returns is stored as-is
    expect(result).toHaveLength(2);
  });

  it('stores logs regardless of which address they came from', async () => {
    db.insertBlock(makeBlock(1));
    client.getLogs = vi.fn(() =>
      Promise.resolve([makeReceiptLog('0xUNKNOWN', '0xANYTOPIC')])
    );
    const processor = new LogsProcessor(
      makeConfig({ addresses: ['0xAAA'], topics: [['0xMATCH']] }),
      db as any,
      client,
      noopLogger
    );
    const result = await processor.process();
    expect(result).toHaveLength(1);
  });



  // ── address batching ───────────────────────────────────────────────────────

  it('splits addresses into batches of addressesBatchSize', async () => {
    db.insertBlock(makeBlock(1));
    const processor = new LogsProcessor(
      makeConfig({ addresses: ['0xA', '0xB', '0xC', '0xD', '0xE'], addressesBatchSize: 2 }),
      db as any,
      client,
      noopLogger
    );
    await processor.process();
    // 5 addresses / batch of 2 => 3 calls
    expect(client.getLogs).toHaveBeenCalledTimes(3);
    expect(client.getLogs).toHaveBeenNthCalledWith(1, 1, 1, ['0xa', '0xb'], undefined);
    expect(client.getLogs).toHaveBeenNthCalledWith(2, 1, 1, ['0xc', '0xd'], undefined);
    expect(client.getLogs).toHaveBeenNthCalledWith(3, 1, 1, ['0xe'], undefined);
  });

  it('makes a single address-less call when no addresses are configured', async () => {
    db.insertBlock(makeBlock(1));
    const processor = new LogsProcessor(
      makeConfig({ addresses: [], topics: [['0xTOPIC']] }),
      db as any,
      client,
      noopLogger
    );
    await processor.process();
    expect(client.getLogs).toHaveBeenCalledTimes(1);
    // address is omitted entirely (undefined), not sent as an empty array
    expect(client.getLogs).toHaveBeenCalledWith(1, 1, undefined, [['0xTOPIC']]);
  });

  it('merges logs from all address batches', async () => {
    db.insertBlock(makeBlock(1));
    client.getLogs = vi.fn((_from: number, _to: number, addresses?: string[]) =>
      Promise.resolve([makeReceiptLog(addresses![0], '0xTOPIC')])
    );
    const processor = new LogsProcessor(
      makeConfig({ addresses: ['0xA', '0xB', '0xC'], addressesBatchSize: 1 }),
      db as any,
      client,
      noopLogger
    );
    const result = await processor.process();
    expect(client.getLogs).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(3);
    expect(result!.map(r => r.address).sort()).toEqual(['0xa', '0xb', '0xc']);
  });

  // ── runtime address updates ────────────────────────────────────────────────

  it('picks up addresses updated via setAddresses on the next process() call', async () => {
    db.insertBlock(makeBlock(1));
    const config = makeConfig({ addresses: ['0xAAA'], addressesBatchSize: 10 });
    const processor = new LogsProcessor(config, db as any, client, noopLogger);

    await processor.process();
    expect(client.getLogs).toHaveBeenNthCalledWith(1, 1, 1, ['0xaaa'], undefined);

    // new address added from outside, and a new block arrives
    config.setAddresses(['0xAAA', '0xBBB']);
    db.insertBlock(makeBlock(2));

    await processor.process();
    expect(client.getLogs).toHaveBeenNthCalledWith(2, 2, 2, ['0xaaa', '0xbbb'], undefined);
  });

  // ── empty log list from client ─────────────────────────────────────────────

  it('returns empty array when getLogs returns no logs', async () => {
    db.insertBlock(makeBlock(1));
    client.getLogs = vi.fn(() => Promise.resolve([]));
    const processor = new LogsProcessor(makeConfig(), db as any, client, noopLogger);
    const result = await processor.process();
    expect(result).toEqual([]);
  });
});
