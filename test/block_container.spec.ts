import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BlockContainer } from '../src/block_container';
import { FatalIndexerError, IndexerError } from '../src/common/errors';
import { ILogger } from '../src/interfaces/logger';

const noopLogger: ILogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

function makeBlock(number: number, hash?: string, parentHash?: string): any {
  return {
    number,
    hash: hash ?? `hash${number}`,
    parentHash: parentHash ?? `hash${number - 1}`,
    timestamp: 0,
    txHashes: [],
  };
}

class MockDB {
  private block: any = null;
  getLastBlock() { return this.block; }
  insertBlock(block: any) { this.block = block; }
}

class MockClient {
  private blocks: Record<number, any> = {};
  setBlock(block: any) { this.blocks[block.number] = block; }
  getBlockByNumber = vi.fn((n: number) => Promise.resolve(this.blocks[n] ?? null));
  getLatestBlock = vi.fn(() => Promise.resolve(this.blocks[Math.max(...Object.keys(this.blocks).map(Number), 0)] ?? null));
}

describe('BlockContainer - full coverage', () => {
  let db: MockDB;
  let client: MockClient;
  let container: BlockContainer;

  beforeEach(() => {
    db = new MockDB();
    client = new MockClient();
    client.getBlockByNumber = vi.fn((n: number) => Promise.resolve(makeBlock(n, `hash${n}`, `hash${n - 1}`)));
  });

  const mkContainer = (confirmations: number, startBlock: number) =>
    new BlockContainer(db, client, confirmations, startBlock, 0, noopLogger);

  it('should initialize with no blocks', async () => {
    container = mkContainer(2, 0);
    await container.init();
    expect(container['latestConfirmedBlock']).toEqual(makeBlock(0, 'hash0', 'hash-1'));
  });

  it('should initialize with a confirmed block', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    expect(container['latestConfirmedBlock']).toEqual(makeBlock(1, 'hash1'));
  });

  it('should initialize with a confirmed block if greater than start block', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    expect(container['latestConfirmedBlock']).toEqual(makeBlock(1, 'hash1'));
  });

  it('should initialize with a specified start block', async () => {
    container = mkContainer(2, 10);
    await container.init();
    expect(container['latestConfirmedBlock']).toEqual(makeBlock(10, 'hash10', 'hash9'));
  });

  it('should confirm a new block after enough confirmations', async () => {
    container = mkContainer(2, 3);
    await container.init();
    // first iteration should be skipped -> block is already last confirmed
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash3', 'hash2')));
    expect(await container.process()).toBe(false);
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(4, 'hash4', 'hash3')));
    expect(await container.process()).toBe(false);
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5', 'hash4')));
    expect(await container.process()).toBe(false);
    // next iteration should be skipped -> block is already inside unconfirmed buffer
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5', 'hash4')));
    expect(await container.process()).toBe(false);
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(6, 'hash6', 'hash5')));
    expect(await container.process()).toBe(true);
    const { number, hash, parentHash } = db.getLastBlock()
    expect([number, hash, parentHash]).toEqual([4, 'hash4', 'hash3']);
  });

  it('should ignore duplicate blocks', async () => {
    container = mkContainer(2, 3);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash3', 'hash2')));
    expect(await container.process()).toBe(false);
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(4, 'hash4', 'hash3')));
    expect(await container.process()).toBe(false);
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(4, 'hash4', 'hash3')));
    expect(await container.process()).toBe(false);
    expect(container['latestConfirmedBlock']).toEqual(makeBlock(3, 'hash3', 'hash2'));
    expect(container['blocksBuffer'].len()).toEqual(1);
    expect(container['blocksBuffer'].peek()).toEqual(makeBlock(4, 'hash4', 'hash3'));
  });

  it('should throw FatalIndexerError if block number matches but hash does not', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    client.setBlock(makeBlock(1, 'DIFFERENT_HASH'));
    container = mkContainer(2, 0);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(1, 'DIFFERENT_HASH')));
    await expect(container.process()).rejects.toThrow(FatalIndexerError);
  });

  it('should throw FatalIndexerError if parentHash does not match latestConfirmedBlock.hash', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    client.setBlock(makeBlock(2, 'hash2', 'WRONG_PARENT'));
    container = mkContainer(2, 0);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2, 'hash2', 'WRONG_PARENT')));
    await expect(container.process()).rejects.toThrow(FatalIndexerError);
  });

  it('should throw FatalIndexerError if block is not recognized in buffer and latestConfirmedBlock exists', async () => {
    container = mkContainer(2, 2);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash31', 'hash2')));
    expect(await container.process()).toBe(false);
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash32', 'hash1')));
    await expect(container.process()).rejects.toThrow(FatalIndexerError);
  });

  it('should handle reorg: new block with different parent', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    // Simulate chain: 2a (hash2a, parent hash1), 3a (hash3a, parent hash2a)
    client.setBlock(makeBlock(2, 'hash2a', 'hash1'));
    client.setBlock(makeBlock(3, 'hash3a', 'hash2a'));
    container = mkContainer(2, 0);
    await container.init();
    // Process up to block 3a
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2, 'hash2a', 'hash1')));
    await container.process();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash3a', 'hash2a')));
    await container.process();
    // Now reorg: block 2b (hash2b, parent hash1), block 3b (hash3b, parent hash2b)
    client.setBlock(makeBlock(2, 'hash2b', 'hash1'));
    client.setBlock(makeBlock(3, 'hash3b', 'hash2b'));
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2, 'hash2b', 'hash1')));
    await container.process(); // should clear buffer and accept new fork
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash3b', 'hash2b')));
    await container.process();
    // Need one more block to fill the buffer (confirmationBlockCount=2) and confirm 2b
    client.setBlock(makeBlock(4, 'hash4b', 'hash3b'));
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(4, 'hash4b', 'hash3b')));
    await container.process();
    // Confirm block 2b
    expect(db.getLastBlock().hash).toBe('hash2b');
  });

  it('should handle out-of-sync: handleNewBlockFromFirst', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    // Simulate missing blocks: jump to block 5
    for (let i = 2; i <= 5; i++) {
      client.setBlock(makeBlock(i, `hash${i}`, `hash${i - 1}`));
    }
    container = mkContainer(2, 0);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5', 'hash4')));
    const confirmed = await container.process();
    expect(confirmed).toBe(true);
    expect(db.getLastBlock().number).toBe(3); // 2 confirmations: block5 confirms block3 (buffer fills at [3,4,5])
  });

  it('should handle out-of-sync: handleNewBlockFromLast', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    // Process block 2 normally to prime the buffer
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2, 'hash2', 'hash1')));
    await container.process();
    // Jump to block 4: gap from newest in buffer (block2) = 2 = confirmationBlockCount → handleNewBlockFromLast
    // It backfills block 3, then pushes [3, 4] → buffer becomes [2, 3, 4] → confirms block 2
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(4, 'hash4', 'hash3')));
    const confirmed = await container.process();
    expect(confirmed).toBe(true);
    expect(db.getLastBlock().number).toBe(2);
  });

  it('should process first block if no confirmed or unconfirmed blocks', async () => {
    container = mkContainer(2, 0);
    await container.init();
    client.setBlock(makeBlock(0, 'hash0', 'hash-1'));
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(0, 'hash0', 'hash-1')));
    const confirmed = await container.process();
    expect(confirmed).toBe(false); // Not enough confirmations yet
  });

  it('should throw FatalIndexerError in init if start block cannot be retrieved (null)', async () => {
    client.getBlockByNumber = vi.fn(() => Promise.resolve(null));
    container = mkContainer(2, 5);
    await expect(container.init()).rejects.toThrow(FatalIndexerError);
  });

  it('should propagate the raw error when getBlockByNumber throws', async () => {
    const networkError = new Error('network error');
    client.getBlockByNumber = vi.fn(() => Promise.reject(networkError));
    container = mkContainer(2, 5);
    await expect(container.init()).rejects.toThrow(networkError);
  });

  it('should throw FatalIndexerError (no originalError) when start block is null', async () => {
    client.getBlockByNumber = vi.fn(() => Promise.resolve(null));
    container = mkContainer(2, 5);
    try {
      await container.init();
      expect.fail('Expected FatalIndexerError to be thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FatalIndexerError);
    }
  });

  it('should return false in process if getLatestBlock returns null', async () => {
    container = mkContainer(2, 0);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(null));
    expect(await container.process()).toBe(false);
  });

  it('should return false for block older than latestConfirmedBlock', async () => {
    db.insertBlock(makeBlock(5, 'hash5', 'hash4'));
    container = mkContainer(2, 0);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash3', 'hash2')));
    expect(await container.process()).toBe(false);
  });

  it('should push first block to buffer when no confirmed and no unconfirmed', async () => {
    // Do NOT call init() - latestConfirmedBlock stays null
    container = mkContainer(2, 0);
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5', 'hash4')));
    const result = await container.process();
    expect(result).toBe(false); // buffer not full yet
    expect(container['latestConfirmedBlock']).toBeNull();
    expect(container['blocksBuffer'].len()).toBe(1);
    expect(container['blocksBuffer'].peek()).toEqual(makeBlock(5, 'hash5', 'hash4'));
  });

  // --- process: unrecognized block in buffer  ---

  it('should throw FatalIndexerError when block parent not found in buffer and confirmed exists', async () => {
    // confirmationBlockCount=3 so buffer holds 4, confirmed=1 stays while we fill [2,3]
    container = new BlockContainer(db, client, 3, 1, 0, noopLogger);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2)));
    await container.process();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3)));
    await container.process();
    // block 4 whose parentHash doesn't match anything in buffer
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(4, 'hash4x', 'hash_wrong')));
    await expect(container.process()).rejects.toThrow(FatalIndexerError);
  });

  it('should clear buffer when block parent not found and no confirmed block', async () => {
    // No init - latestConfirmedBlock is null
    container = mkContainer(2, 0);
    // Push first block to buffer via lines 69-70 path
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5', 'hash4')));
    await container.process();
    expect(container['blocksBuffer'].len()).toBe(1);
    // Block with same number but unrecognizable parent - buffer should be cleared
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5x', 'WEIRD')));
    await container.process();
    expect(container['blocksBuffer'].len()).toBe(1); // cleared then new block pushed
    expect(container['blocksBuffer'].peek()!.hash).toBe('hash5x');
  });

  it('should throw IndexerError in handleNewBlockFromFirst when intermediate block is null', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    // gap of 5 (block 6 - block 1 = 5 > confirmationBlockCount=2) => handleNewBlockFromFirst
    client.getBlockByNumber = vi.fn((n: number) =>
      n === 3 ? Promise.resolve(null) : Promise.resolve(makeBlock(n))
    );
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(6)));
    await expect(container.process()).rejects.toThrow(IndexerError);
  });

  it('should warn and return when intermediate block parent hash mismatches in handleNewBlockFromFirst', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    // Block 3 returned with wrong parentHash - should warn and return, leaving block2 in buffer
    client.getBlockByNumber = vi.fn((n: number) =>
      n === 3
        ? Promise.resolve(makeBlock(3, 'hash3', 'WRONG_PARENT'))
        : Promise.resolve(makeBlock(n))
    );
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(6)));
    const warnSpy = vi.spyOn(noopLogger, 'warn');
    const result = await container.process();
    expect(result).toBe(false); // no confirmations yet
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(container['blocksBuffer'].isEmpty()).toBe(true);
    warnSpy.mockRestore();
  });

  it('should warn and return when final block parent hash mismatches in handleNewBlockFromFirst', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    // Blocks 2,3,4 are fine and fill the buffer confirming block2; block5 has WRONG parentHash
    // → warn and return true (block2 was confirmed), buffer has [3,4]
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5', 'WRONG_PARENT')));
    const warnSpy = vi.spyOn(noopLogger, 'warn');
    const result = await container.process();
    expect(result).toBe(true); // block2 was confirmed during backfill
    expect(db.getLastBlock().number).toBe(2);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(container['blocksBuffer'].len()).toBe(0);
    warnSpy.mockRestore();
  });

  it('should throw IndexerError in handleNewBlockFromLast when backfilled block is null', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    // Prime buffer with block 2
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2)));
    await container.process();
    // Jump to block 4: gap=4-3=1 <= 2 => handleNewBlockFromLast, backfills block 3
    client.getBlockByNumber = vi.fn((n: number) =>
      n === 3 ? Promise.resolve(null) : Promise.resolve(makeBlock(n))
    );
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(4)));
    await expect(container.process()).rejects.toThrow(IndexerError);
  });

  it('should recover gracefully in handleNewBlockFromLast when backfilled block hash mismatches', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2)));
    await container.process();
    // Block 5 with WEIRD_PARENT: its parentHash doesn't match block4.hash.
    // New behavior: discard block5, continue backfilling from block4 downward,
    // reconnect to block2 in buffer via block3, confirm block2.
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5', 'WEIRD_PARENT')));
    const confirmed = await container.process();
    expect(confirmed).toBe(true);
    expect(db.getLastBlock().number).toBe(2);
  });

  it('should handle deep reorg in handleNewBlockFromLast and reconnect to confirmed', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    // Build buffer [2a, 3a] on fork-a
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2, 'hash2a', 'hash1')));
    await container.process();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash3a', 'hash2a')));
    await container.process();
    // Fork-b blocks (reconnect to confirmed hash1 via 2b)
    const forkB: Record<number, any> = {
      2: makeBlock(2, 'hash2b', 'hash1'),
      3: makeBlock(3, 'hash3b', 'hash2b'),
      4: makeBlock(4, 'hash4b', 'hash3b'),
    };
    client.getBlockByNumber = vi.fn((n: number) => Promise.resolve(forkB[n] ?? null));
    // Block 5b: gap=5-4=1 <= 2 => handleNewBlockFromLast; backfills 4b
    // 4b.parentHash(hash3b) !== 3a.hash(hash3a) => deep reorg path
    // deep backfill fetches 3b,2b => connects to hash1
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5b', 'hash4b')));
    const confirmed = await container.process();
    expect(confirmed).toBe(true);
    expect(db.getLastBlock().hash).toBe('hash3b');
  });

  it('should throw FatalIndexerError in deep reorg when chain does not connect to confirmed', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2, 'hash2a', 'hash1')));
    await container.process();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash3a', 'hash2a')));
    await container.process();
    // Fork-b: block 2b has WRONG parentHash - does NOT connect to confirmed hash1
    const forkB: Record<number, any> = {
      2: makeBlock(2, 'hash2b', 'WRONG_ROOT'),
      3: makeBlock(3, 'hash3b', 'hash2b'),
      4: makeBlock(4, 'hash4b', 'hash3b'),
    };
    client.getBlockByNumber = vi.fn((n: number) => Promise.resolve(forkB[n] ?? null));
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5b', 'hash4b')));
    await expect(container.process()).rejects.toThrow(FatalIndexerError);
  });

  it('should throw IndexerError in deep reorg when a backfilled block is null', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2, 'hash2a', 'hash1')));
    await container.process();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash3a', 'hash2a')));
    await container.process();
    // Only block 4b available, block 3 missing in deep backfill => null => line 184
    const forkB: Record<number, any> = {
      4: makeBlock(4, 'hash4b', 'hash3b'),
    };
    client.getBlockByNumber = vi.fn((n: number) => Promise.resolve(forkB[n] ?? null));
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5b', 'hash4b')));
    await expect(container.process()).rejects.toThrow(IndexerError);
  });

  it('should throw IndexerError in deep reorg when backfilled block hash mismatches', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(2, 'hash2a', 'hash1')));
    await container.process();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash3a', 'hash2a')));
    await container.process();
    // Block 3 returned with wrong hash in deep backfill - 4b.parentHash(hash3b) !== WRONG_HASH
    const forkB: Record<number, any> = {
      3: makeBlock(3, 'WRONG_HASH', 'hash2b'),
      4: makeBlock(4, 'hash4b', 'hash3b'),
    };
    client.getBlockByNumber = vi.fn((n: number) => Promise.resolve(forkB[n] ?? null));
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5b', 'hash4b')));
    await expect(container.process()).rejects.toThrow(IndexerError);
  });

  it('should keep confirming blocks after a failed insert instead of wedging the buffer', async () => {
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();

    // One failing write, the way a primary key clash on a replayed height does
    const failOnce = vi.spyOn(db, 'insertBlock').mockImplementationOnce(() => {
      throw new Error('UNIQUE constraint failed: blocks.number');
    });

    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(5, 'hash5', 'hash4')));
    await expect(container.process()).rejects.toThrow('UNIQUE constraint failed');

    // The buffer must have room again, so the next pass is not 'buffer is full'
    failOnce.mockRestore();
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(6, 'hash6', 'hash5')));
    await expect(container.process()).resolves.toBe(true);
    expect(container['latestConfirmedBlock']!.number).toBeGreaterThan(1);
  });

  it('should throw FatalIndexerError when oldest backfilled block does not connect to confirmed block', async () => {
    // confirmed=block1(hash1), buffer empty
    // lastBlock=block3: block.number - latestInMemBlock.number = 3-1 = 2 = confirmationBlockCount → handleNewBlockFromLast
    // backfill: block2(parent=WRONG_PARENT)
    // block2.number === confirmed.number+1, but block2.parentHash !== confirmed.hash → FatalIndexerError
    db.insertBlock(makeBlock(1, 'hash1'));
    container = mkContainer(2, 0);
    await container.init();
    client.getBlockByNumber = vi.fn((n: number) => Promise.resolve({
      2: makeBlock(2, 'hash2b', 'WRONG_PARENT'),
    }[n] ?? null));
    client.getLatestBlock = vi.fn(() => Promise.resolve(makeBlock(3, 'hash3b', 'hash2b')));
    await expect(container.process()).rejects.toThrow(FatalIndexerError);
  });
});
