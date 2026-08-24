import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Indexer, NewLogCallback } from '../src/indexer';
import { Config } from '../src/config';
import { ILogger } from '../src/interfaces/logger';
import { FatalIndexerError, IndexerError } from '../src/common/errors';
import { LogEvent } from '../src/common/data';

// ── mock heavy dependencies ───────────────────────────────────────────────────

vi.mock('../src/block_container');
vi.mock('../src/logs_processor');

import { BlockContainer } from '../src/block_container';
import { LogsProcessor } from '../src/logs_processor';

// ── shared helpers ────────────────────────────────────────────────────────────

const noopLogger: ILogger = {
  trace: () => { },
  debug: () => { },
  info: () => { },
  warn: () => { },
  error: () => { },
  fatal: () => { },
};

function makeConfig(): Config {
  return new Config({
    startBlockNumber: 0,
    confirmationBlocksCount: 12,
    maxBatchSize: 10,
    // zero intervals → sleep(0) returns immediately (no real delay)
    pullBlockIntervalMs: 0,
    pullBlocksLoopIntervalMs: 0,
    pullLogsIntervalMs: 0,
    addresses: ['0xAAA'],
    topics: undefined,
  });
}

class MockDB {
  initDb = vi.fn();
  getLastBlock = vi.fn(() => null);
  insertBlock = vi.fn();
  getBlocks = vi.fn(() => []);
  getLastProcessedBlock = vi.fn((): number | null => null);
  insertEventAndSetLastProcessedBlock = vi.fn();
  getLastProcessedEvent = vi.fn((): number | null => null);
  setLastProcessedEvent = vi.fn();
  getEvents = vi.fn(() => [] as LogEvent[]);
}

class MockClient {
  getBlockByNumber = vi.fn(() => Promise.resolve(null));
  getLatestBlock = vi.fn(() => Promise.resolve(null));
  getLogs = vi.fn(() => Promise.resolve([]));
}

function makeSampleLogs(): LogEvent[] {
  return [{
    id: 1,
    blockNumber: 1,
    txHash: '0xtx1',
    logIndex: 0,
    txIndex: 0,
    address: '0xAAA',
    topics: ['0x01'],
    data: '0x',
  }];
}

// ── test setup ────────────────────────────────────────────────────────────────

describe('Indexer', () => {
  let config: Config;
  let db: MockDB;
  let client: MockClient;
  let mockContainerInit: ReturnType<typeof vi.fn>;
  let mockContainerProcess: ReturnType<typeof vi.fn>;
  let mockLogsProcess: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    config = makeConfig();
    db = new MockDB();
    client = new MockClient();

    mockContainerInit = vi.fn().mockResolvedValue(undefined);
    mockContainerProcess = vi.fn().mockResolvedValue(false);
    mockLogsProcess = vi.fn().mockResolvedValue(undefined);

    (BlockContainer as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return { init: mockContainerInit, process: mockContainerProcess };
    });

    (LogsProcessor as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return { process: mockLogsProcess };
    });
  });

  // ── constructor ───────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('instantiates BlockContainer with config values', () => {
      new Indexer(config, client, db, noopLogger);
      expect(BlockContainer).toHaveBeenCalledOnce();
      const [dbArg, clientArg, confirmations, startBlock, intervalMs] =
        (BlockContainer as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(dbArg).toBe(db);
      expect(clientArg).toBe(client);
      expect(confirmations).toBe(config.getConfirmationBlocksCount());
      expect(startBlock).toBe(config.getStartBlockNumber());
      expect(intervalMs).toBe(config.getPullBlocksLoopIntervalMs());
    });

    it('instantiates LogsProcessor with config', () => {
      new Indexer(config, client, db, noopLogger);
      expect(LogsProcessor).toHaveBeenCalledOnce();
      const [cfgArg] = (LogsProcessor as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(cfgArg).toBe(config);
    });

    it('running is false before start()', () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      expect(indexer.isRunning()).toBe(false);
    });
  });

  // ── init() ────────────────────────────────────────────────────────────────

  describe('init()', () => {
    it('calls db.initDb()', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      await indexer.init();
      expect(db.initDb).toHaveBeenCalledOnce();
    });

    it('calls blocksContainer.init()', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      await indexer.init();
      expect(mockContainerInit).toHaveBeenCalledOnce();
    });

    it('propagates errors thrown by blocksContainer.init()', async () => {
      const initError = new FatalIndexerError('init failed');
      mockContainerInit.mockRejectedValueOnce(initError);
      const indexer = new Indexer(config, client, db, noopLogger);
      await expect(indexer.init()).rejects.toThrow(initError);
    });
  });

  // ── isRunning() ───────────────────────────────────────────────────────────

  describe('isRunning()', () => {
    it('returns false before start()', () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      expect(indexer.isRunning()).toBe(false);
    });

    it('returns true once start() is called', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      mockContainerProcess.mockImplementationOnce(async () => {
        // isRunning() must be true during execution
        expect(indexer.isRunning()).toBe(true);
        indexer.stop();
        return false;
      });
      await indexer.start();
    });
  });

  // ── stop() ────────────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('sets isRunning() to false', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      mockContainerProcess.mockImplementationOnce(async () => {
        indexer.stop();
        return false;
      });
      await indexer.start();
      expect(indexer.isRunning()).toBe(false);
    });

    it('calling stop() before start() leaves running false', () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      indexer.stop();
      expect(indexer.isRunning()).toBe(false);
    });
  });

  // ── start() – loops run ───────────────────────────────────────────────────

  describe('start()', () => {
    it('runs both blocks loop and logs loop', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      // First iteration must NOT call stop() synchronously so logsLoop starts before running=false
      mockContainerProcess
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(async () => { indexer.stop(); return false; });
      await indexer.start();
      expect(mockContainerProcess).toHaveBeenCalled();
      expect(mockLogsProcess).toHaveBeenCalled();
    });

    it('resolves after stop() is called', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      mockContainerProcess.mockImplementationOnce(async () => {
        indexer.stop();
        return false;
      });
      // start() returns Promise.all which resolves to an array – just ensure it resolves
      await expect(indexer.start()).resolves.toBeDefined();
    });

    it('loops call process() on each iteration', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      let calls = 0;
      mockContainerProcess.mockImplementation(async () => {
        calls++;
        if (calls >= 3) indexer.stop();
        return false;
      });
      await indexer.start();
      expect(mockContainerProcess).toHaveBeenCalledTimes(3);
    });
  });

  // ── executeLoop – error handling ──────────────────────────────────────────

  describe('executeLoop – FatalIndexerError', () => {
    it('stops the indexer when thrown from blocks loop', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      const fatal = new FatalIndexerError('fatal blocks');
      mockContainerProcess.mockRejectedValueOnce(fatal);
      await expect(indexer.start()).rejects.toThrow(fatal);
      expect(indexer.isRunning()).toBe(false);
    });

    it('rethrows FatalIndexerError from blocks loop', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      const fatal = new FatalIndexerError('fatal blocks rethrow');
      mockContainerProcess.mockRejectedValueOnce(fatal);
      await expect(indexer.start()).rejects.toBeInstanceOf(FatalIndexerError);
    });

    it('stops the indexer when thrown from logs loop', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      const fatal = new FatalIndexerError('fatal logs');
      mockLogsProcess.mockRejectedValueOnce(fatal);
      await expect(indexer.start()).rejects.toThrow(fatal);
      expect(indexer.isRunning()).toBe(false);
    });

    it('rethrows FatalIndexerError from logs loop', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      const fatal = new FatalIndexerError('fatal logs rethrow');
      mockLogsProcess.mockRejectedValueOnce(fatal);
      await expect(indexer.start()).rejects.toBeInstanceOf(FatalIndexerError);
    });

    it('logs the fatal error from blocks loop', async () => {
      const logger = { ...noopLogger, error: vi.fn() };
      const indexer = new Indexer(config, client, db, logger);
      const fatal = new FatalIndexerError('fatal blocks log');
      mockContainerProcess.mockRejectedValueOnce(fatal);
      try { await indexer.start(); } catch { /* expected */ }
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: fatal }),
        expect.stringContaining('fatal error'),
      );
    });

    it('logs the fatal error from logs loop', async () => {
      const logger = { ...noopLogger, error: vi.fn() };
      const indexer = new Indexer(config, client, db, logger);
      const fatal = new FatalIndexerError('fatal logs log');
      mockLogsProcess.mockRejectedValueOnce(fatal);
      try { await indexer.start(); } catch { /* expected */ }
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: fatal }),
        expect.stringContaining('fatal error'),
      );
    });
  });

  describe('executeLoop – recoverable IndexerError', () => {
    it('blocks loop continues after IndexerError', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      let call = 0;
      mockContainerProcess.mockImplementation(async () => {
        call++;
        if (call === 1) throw new IndexerError('recoverable blocks');
        indexer.stop();
        return false;
      });
      await indexer.start();
      expect(indexer.isRunning()).toBe(false);
      expect(mockContainerProcess).toHaveBeenCalledTimes(2);
    });

    it('logs loop continues after IndexerError', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      let callLogs = 0;
      mockLogsProcess.mockImplementation(async () => {
        callLogs++;
        if (callLogs === 1) throw new IndexerError('recoverable logs');
        return undefined;
      });
      mockContainerProcess
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(async () => { indexer.stop(); return false; });

      await indexer.start();
      expect(callLogs).toBeGreaterThanOrEqual(2);
    });

    it('logs recoverable IndexerError from blocks loop', async () => {
      const logger = { ...noopLogger, error: vi.fn() };
      const indexer = new Indexer(config, client, db, logger);
      const err = new IndexerError('recoverable');
      let call = 0;
      mockContainerProcess.mockImplementation(async () => {
        call++;
        if (call === 1) throw err;
        indexer.stop();
        return false;
      });
      await indexer.start();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        expect.stringContaining('recoverable error'),
      );
    });
  });

  describe('executeLoop – generic non-IndexerError', () => {
    it('blocks loop continues after generic Error', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      let call = 0;
      mockContainerProcess.mockImplementation(async () => {
        call++;
        if (call === 1) throw new Error('network blip');
        indexer.stop();
        return false;
      });
      await indexer.start();
      expect(mockContainerProcess).toHaveBeenCalledTimes(2);
    });

    it('logs loop continues after generic Error', async () => {
      const indexer = new Indexer(config, client, db, noopLogger);
      let callLogs = 0;
      mockLogsProcess.mockImplementation(async () => {
        callLogs++;
        if (callLogs === 1) throw new Error('generic logs error');
        return undefined;
      });
      mockContainerProcess
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(async () => { indexer.stop(); return false; });

      await indexer.start();
      expect(callLogs).toBeGreaterThanOrEqual(2);
    });

    it('logs generic error from blocks loop as "other recoverable error"', async () => {
      const logger = { ...noopLogger, error: vi.fn() };
      const indexer = new Indexer(config, client, db, logger);
      const err = new Error('generic');
      let call = 0;
      mockContainerProcess.mockImplementation(async () => {
        call++;
        if (call === 1) throw err;
        indexer.stop();
        return false;
      });
      await indexer.start();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        expect.stringContaining('other recoverable error'),
      );
    });

    it('logs generic error from logs loop as "other recoverable error"', async () => {
      const logger = { ...noopLogger, error: vi.fn() };
      const indexer = new Indexer(config, client, db, logger);
      const err = new Error('logs generic');
      let callLogs = 0;
      mockLogsProcess.mockImplementation(async () => {
        callLogs++;
        if (callLogs === 1) throw err;
        return undefined;
      });
      mockContainerProcess
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(async () => { indexer.stop(); return false; });

      await indexer.start();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        expect.stringContaining('other recoverable error'),
      );
    });
  });

  // ── executeLoop – lifecycle logging ───────────────────────────────────────

  describe('executeLoop – lifecycle logging', () => {
    it('logs "started" and "stopped" for both loops', async () => {
      const logger = { ...noopLogger, info: vi.fn() };
      const indexer = new Indexer(config, client, db, logger);
      mockContainerProcess.mockImplementationOnce(async () => {
        indexer.stop();
        return false;
      });
      await indexer.start();

      const messages: string[] = logger.info.mock.calls.map((c: unknown[]) =>
        typeof c[0] === 'string' ? c[0] : String(c[1] ?? c[0]),
      );
      expect(messages.some(m => m.includes('blocks') && m.includes('started'))).toBe(true);
      expect(messages.some(m => m.includes('blocks') && m.includes('stopped'))).toBe(true);
      expect(messages.some(m => m.includes('logs') && m.includes('started'))).toBe(true);
      expect(messages.some(m => m.includes('logs') && m.includes('stopped'))).toBe(true);
    });
  });

  // ── newLogCallback ────────────────────────────────────────────────────────

  describe('newLogCallback', () => {
    it('is called when logs processor returns non-empty logs', async () => {
      const callback: NewLogCallback = vi.fn().mockResolvedValue(undefined);
      const indexer = new Indexer(config, client, db, noopLogger, callback);
      const logs = makeSampleLogs();
      mockLogsProcess.mockResolvedValueOnce(logs);
      // No-op on first blocks iteration so logsLoop has a chance to call its action first
      mockContainerProcess
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(async () => { indexer.stop(); return false; });
      await indexer.start();
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(db, logs);
    });

    it('passes the db instance as first argument to the callback', async () => {
      const callback: NewLogCallback = vi.fn().mockResolvedValue(undefined);
      const indexer = new Indexer(config, client, db, noopLogger, callback);
      mockLogsProcess.mockResolvedValueOnce(makeSampleLogs());
      mockContainerProcess
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(async () => { indexer.stop(); return false; });
      await indexer.start();
      expect((callback as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(db);
    });

    it('is NOT called when logs processor returns undefined', async () => {
      const callback: NewLogCallback = vi.fn().mockResolvedValue(undefined);
      const indexer = new Indexer(config, client, db, noopLogger, callback);
      mockLogsProcess.mockResolvedValueOnce(undefined);
      mockContainerProcess.mockImplementationOnce(async () => {
        indexer.stop();
        return false;
      });
      await indexer.start();
      expect(callback).not.toHaveBeenCalled();
    });

    it('is NOT called when logs processor returns an empty array', async () => {
      const callback: NewLogCallback = vi.fn().mockResolvedValue(undefined);
      const indexer = new Indexer(config, client, db, noopLogger, callback);
      mockLogsProcess.mockResolvedValueOnce([]);
      mockContainerProcess.mockImplementationOnce(async () => {
        indexer.stop();
        return false;
      });
      await indexer.start();
      expect(callback).not.toHaveBeenCalled();
    });

    it('is NOT called when no callback is provided', async () => {
      // Arrange: no callback
      const indexer = new Indexer(config, client, db, noopLogger);
      mockLogsProcess.mockResolvedValueOnce(makeSampleLogs());
      mockContainerProcess.mockImplementationOnce(async () => {
        indexer.stop();
        return false;
      });
      // Should not throw even though newLogs is non-empty and callback is undefined
      await indexer.start();
    });

    it('is called multiple times across iterations', async () => {
      const callback: NewLogCallback = vi.fn().mockResolvedValue(undefined);
      const indexer = new Indexer(config, client, db, noopLogger, callback);
      let logsCalls = 0;
      mockLogsProcess.mockImplementation(async () => {
        logsCalls++;
        return logsCalls <= 2 ? makeSampleLogs() : undefined;
      });
      let blockCalls = 0;
      mockContainerProcess.mockImplementation(async () => {
        blockCalls++;
        if (blockCalls >= 3) indexer.stop();
        return false;
      });
      await indexer.start();
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('errors in callback are propagated (treated as fatal by executeLoop)', async () => {
      const callbackError = new FatalIndexerError('callback fatal');
      const callback: NewLogCallback = vi.fn().mockRejectedValueOnce(callbackError);
      const indexer = new Indexer(config, client, db, noopLogger, callback);
      mockLogsProcess.mockResolvedValueOnce(makeSampleLogs());
      // blocks loop keeps running until fatal sets running=false
      mockContainerProcess.mockResolvedValue(false);
      await expect(indexer.start()).rejects.toThrow(callbackError);
      expect(indexer.isRunning()).toBe(false);
    });

    it('non-fatal errors in callback are swallowed by logs loop (recoverable)', async () => {
      const callbackError = new Error('callback recoverable');
      const callback: NewLogCallback = vi.fn()
        .mockRejectedValueOnce(callbackError)
        .mockResolvedValue(undefined);
      const indexer = new Indexer(config, client, db, noopLogger, callback);
      let logsCalls = 0;
      mockLogsProcess.mockImplementation(async () => {
        logsCalls++;
        return logsCalls <= 1 ? makeSampleLogs() : undefined;
      });
      mockContainerProcess
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(async () => { indexer.stop(); return false; });

      await indexer.start();
    });
  });
});
