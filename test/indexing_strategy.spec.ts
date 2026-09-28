import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BlockTrackingStrategy,
  ConfirmedRangeStrategy,
  createIndexingStrategy,
} from '../src/indexing_strategy';
import { Config } from '../src/config';
import { IndexingMode, LogEvent } from '../src/common/data';
import { ILogger } from '../src/interfaces/logger';

vi.mock('../src/block_container');
vi.mock('../src/logs_processor');
vi.mock('../src/confirmed_range_processor');

import { BlockContainer } from '../src/block_container';
import { LogsProcessor } from '../src/logs_processor';
import { ConfirmedRangeProcessor } from '../src/confirmed_range_processor';

type Mock = ReturnType<typeof vi.fn>;

const noopLogger: ILogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

function makeConfig(indexingMode?: IndexingMode): Config {
  return new Config({
    startBlockNumber: 7,
    confirmationBlocksCount: 12,
    maxBatchSize: 10,
    pullBlockIntervalMs: 3000,
    pullBlocksLoopIntervalMs: 500,
    pullLogsIntervalMs: 4000,
    addresses: ['0xAAA'],
    topics: undefined,
    indexingMode,
  });
}

const logs: LogEvent[] = [{
  id: 1, blockNumber: 1, txHash: '0xtx', logIndex: 0, txIndex: 0, address: '0xAAA', topics: ['0x01'], data: '0x',
}];

describe('indexing strategy', () => {
  const client = {} as any;
  const db = {} as any;
  let containerInit: Mock;
  let containerProcess: Mock;
  let logsProcess: Mock;
  let rangeProcess: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    containerInit = vi.fn().mockResolvedValue(undefined);
    containerProcess = vi.fn().mockResolvedValue(true);
    logsProcess = vi.fn().mockResolvedValue(logs);
    rangeProcess = vi.fn().mockResolvedValue(logs);
    (BlockContainer as unknown as Mock).mockImplementation(function () {
      return { init: containerInit, process: containerProcess };
    });
    (LogsProcessor as unknown as Mock).mockImplementation(function () {
      return { process: logsProcess };
    });
    (ConfirmedRangeProcessor as unknown as Mock).mockImplementation(function () {
      return { process: rangeProcess };
    });
  });

  describe('createIndexingStrategy', () => {
    it('tracks blocks unless told otherwise', () => {
      expect(createIndexingStrategy(makeConfig(), client, db, noopLogger))
        .toBeInstanceOf(BlockTrackingStrategy);
      expect(createIndexingStrategy(makeConfig(IndexingMode.BlockTracking), client, db, noopLogger))
        .toBeInstanceOf(BlockTrackingStrategy);
    });

    it('fetches confirmed ranges when configured', () => {
      expect(createIndexingStrategy(makeConfig(IndexingMode.ConfirmedRange), client, db, noopLogger))
        .toBeInstanceOf(ConfirmedRangeStrategy);
    });
  });

  describe('BlockTrackingStrategy', () => {
    it('wires the block container from the config', () => {
      const config = makeConfig();
      new BlockTrackingStrategy(config, client, db, noopLogger);
      expect(BlockContainer).toHaveBeenCalledWith(db, client, 12, 7, 500, noopLogger);
      expect(LogsProcessor).toHaveBeenCalledWith(config, db, client, noopLogger);
    });

    it('init confirms the start block through the container', async () => {
      await new BlockTrackingStrategy(makeConfig(), client, db, noopLogger).init();
      expect(containerInit).toHaveBeenCalledOnce();
    });

    it('runs a blocks loop and a logs loop at their own intervals', async () => {
      const loops = new BlockTrackingStrategy(makeConfig(), client, db, noopLogger).loops();
      const signal = new AbortController().signal;

      expect(loops.map((l) => [l.name, l.intervalMs])).toEqual([['blocks', 3000], ['logs', 4000]]);
      expect(await loops[0].run(signal)).toBeUndefined();
      expect(containerProcess).toHaveBeenCalledWith(signal);
      expect(await loops[1].run(signal)).toBe(logs);
      expect(logsProcess).toHaveBeenCalledWith(signal);
    });
  });

  describe('ConfirmedRangeStrategy', () => {
    it('has nothing to prepare', async () => {
      await expect(new ConfirmedRangeStrategy(makeConfig(), client, db, noopLogger).init()).resolves.toBeUndefined();
    });

    it('runs a single logs loop', async () => {
      const loops = new ConfirmedRangeStrategy(makeConfig(), client, db, noopLogger).loops();
      const signal = new AbortController().signal;

      expect(loops.map((l) => [l.name, l.intervalMs])).toEqual([['logs', 4000]]);
      expect(await loops[0].run(signal)).toBe(logs);
      expect(rangeProcess).toHaveBeenCalledWith(signal);
    });
  });
});

describe('Config indexing mode', () => {
  const original = process.env.INDEXING_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.INDEXING_MODE;
    else process.env.INDEXING_MODE = original;
  });

  it('defaults to block tracking', () => {
    delete process.env.INDEXING_MODE;
    expect(makeConfig().getIndexingMode()).toBe(IndexingMode.BlockTracking);
    expect(new Config().getIndexingMode()).toBe(IndexingMode.BlockTracking);
  });

  it('reads INDEXING_MODE from the environment', () => {
    process.env.INDEXING_MODE = 'confirmed_range';
    expect(new Config().getIndexingMode()).toBe(IndexingMode.ConfirmedRange);
  });

  it('rejects an unknown INDEXING_MODE', () => {
    process.env.INDEXING_MODE = 'sideways';
    expect(() => new Config()).toThrow(/INDEXING_MODE/);
  });
});
