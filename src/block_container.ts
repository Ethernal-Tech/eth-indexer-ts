import { CircularBuffer } from "./common/circularBuffer";
import { Block } from "./common/data";
import { IndexerError, FatalIndexerError } from "./common/errors"
import { sleep } from "./common/utils";
import { IBlocksDatabase } from "./interfaces/database";
import { IEthBlocksClient } from "./interfaces/ethClient";
import { ILogger } from "./interfaces/logger";

export class BlockContainer {
  private latestConfirmedBlock: Block | null = null;
  private readonly blocksBuffer: CircularBuffer<Block>;
  private readonly confirmationBlockCount: number;
  private readonly pullBlocksLoopIntervalMs: number;
  private readonly startBlockNumber: number;
  private readonly client: IEthBlocksClient;
  private readonly db: IBlocksDatabase;
  private readonly logger: ILogger;

  constructor(
    db: IBlocksDatabase,
    client: IEthBlocksClient,
    confirmationBlockCount: number,
    startBlockNumber: number | undefined | null,
    pullBlocksLoopIntervalMs: number,
    logger: ILogger,
  ) {
    this.db = db;
    this.client = client;
    this.logger = logger;
    this.confirmationBlockCount = confirmationBlockCount;
    if (!startBlockNumber || startBlockNumber <= 0) {
      this.startBlockNumber = 0;
    } else {
      this.startBlockNumber = startBlockNumber;
    }
    this.pullBlocksLoopIntervalMs = pullBlocksLoopIntervalMs;
    this.blocksBuffer = new CircularBuffer<Block>(confirmationBlockCount + 1);
  }

  async init() {
    const latestConfirmedBlock = this.db.getLastBlock();
    if (latestConfirmedBlock === null || this.startBlockNumber > latestConfirmedBlock.number) {
      // NOTE: in this case we are assuming that startBlockNumber is confirmed!
      this.latestConfirmedBlock = await this.client.getBlockByNumber(this.startBlockNumber);
      if (this.latestConfirmedBlock === null) {
        throw new FatalIndexerError(`Failed to retrieve start block ${this.startBlockNumber}`);
      }
      this.db.insertBlock(this.latestConfirmedBlock);
    } else {
      this.latestConfirmedBlock = latestConfirmedBlock;
    }
  }

  async process(): Promise<boolean> {
    const block = await this.client.getLatestBlock();
    if (!block) {
      return false;
    }

    // check if block is already latest unconfirmed block
    const newestUnconfirmed = this.blocksBuffer.peekNewest();
    if (newestUnconfirmed && newestUnconfirmed.number === block.number && newestUnconfirmed.hash === block.hash) {
      return false;
    }

    // check current block with latest confirmed block
    if (this.latestConfirmedBlock) {
      if (this.latestConfirmedBlock.number === block.number) {
        if (this.latestConfirmedBlock.hash !== block.hash) {
          throw new FatalIndexerError(
            `Block has the same number ${block.number} but a different hash ${block.hash} than confirmed block ${this.latestConfirmedBlock.hash}`);
        }
        // clear everything in unconfirmed block buffer
        this.blocksBuffer.clear();
        return false; // block is latest confirmed
      } else if (this.latestConfirmedBlock.number > block.number) {
        return false; // old block        
      } else if (this.latestConfirmedBlock.number + 1 === block.number) {
        // throw fatal error if hashes do not match
        if (this.latestConfirmedBlock.hash !== block.parentHash) {
          throw new FatalIndexerError(
            `Block ${block.number} (${block.hash}) parent hash ${block.parentHash} does not match confirmed block hash ${this.latestConfirmedBlock.hash}`);
        }
        // new block will be first (and only) in unconfirmed blocks buffer
        this.blocksBuffer.clear();
        return this.addBlock(block);
      }
    }

    // check if block is out to sync (more than one block from latest)
    const latestInMemBlock = this.getLatestBlock();
    if (latestInMemBlock && latestInMemBlock!.number + 1 < block.number) {
      if (block.number - latestInMemBlock!.number > this.confirmationBlockCount) {
        // synchronize from beggining of the buffer, which is safe height
        return await this.handleNewBlockFromFirst(block);
      }
      // synchronize from latest confirmed block, which is safe height
      return await this.handleNewBlockFromLast(block);
    }

    // check block against blocks already in unconfirmed blocks buffer
    const [indx] = this.blocksBuffer.find((x) => x.number + 1 === block.number && x.hash === block.parentHash, true);
    // fatal exception if parent not found in buffer but also does not match latest confirmed block (full check is in code above)
    if (indx === -1 && this.latestConfirmedBlock) {
      throw new FatalIndexerError(
        `Invalid block ${block.number} (${block.hash}) for confirmed block ${this.latestConfirmedBlock.number} (${this.latestConfirmedBlock.hash})`);
    }

    // clear everything after parent block in unconfirmed blocks buffer
    // or clear everything if parent block is latest confirmed block (indx === -1)
    this.blocksBuffer.clearAfter(indx);
    return this.addBlock(block);
  }

  private async handleNewBlockFromFirst(lastBlock: Block): Promise<boolean> {
    let hasNewConfirmedBlock = false;
    let currentBlock = this.getLatestBlock();
    const startBlockNumber = currentBlock ? currentBlock.number + 1 : 0;
    for (let i = startBlockNumber; i < lastBlock.number; i++) {
      const block = await this.client.getBlockByNumber(i);
      if (!block) {
        throw new IndexerError(`Failed to retrieve block ${i} while synchronizing from first block`);
      } else if (currentBlock && currentBlock.hash !== block.parentHash) {
        // just clear everything in buffer, because we are not sure which blocks are valid anymore,
        // but log warning about parent hash mismatch (original code before copilot suggestion was: this.blocksBuffer.popNewest())
        this.blocksBuffer.clear();

        this.logger.warn({ number: i, expectedParentHash: currentBlock.hash, gotParentHash: block.parentHash }, 'Parent hash mismatch while synchronizing from first block');
        return hasNewConfirmedBlock;
      }

      const nb = this.addBlock(block);
      hasNewConfirmedBlock ||= nb;
      currentBlock = block;

      await sleep(this.pullBlocksLoopIntervalMs);
    }

    if (currentBlock!.hash !== lastBlock.parentHash) {
      // suggested by copilot, same as above
      this.blocksBuffer.clear();
      this.logger.warn({ number: lastBlock.number, expectedParentHash: currentBlock!.hash, gotParentHash: lastBlock.parentHash }, 'Parent hash mismatch for final block while synchronizing from first block');
      return hasNewConfirmedBlock;
    }

    const nb = this.addBlock(lastBlock);
    return hasNewConfirmedBlock || nb;
  }

  private async handleNewBlockFromLast(lastBlock: Block): Promise<boolean> {
    const lowestBlockNum = this.latestConfirmedBlock ? this.latestConfirmedBlock.number + 1 : 0;
    const blocks = [lastBlock];
    for (let i = lastBlock.number - 1; i >= lowestBlockNum; i--) {
      const block = await this.client.getBlockByNumber(i);
      if (!block) {
        throw new IndexerError(`Failed to retrieve block ${i} while synchronizing from last block`);
      } else if (blocks[blocks.length - 1].parentHash !== block.hash) {
        // if previous block does not match parent hash of last block
        // we have to clear all current blocks in array, because they are not valid anymore        
        blocks.length = 0;
        this.logger.warn({ number: i, hash: block.hash }, 'Parent hash mismatch while synchronizing from last block, clearing all currently retrieved blocks');
      }

      const firstUnconfirmedBlock = this.blocksBuffer.peekNewest();
      if (firstUnconfirmedBlock && firstUnconfirmedBlock.number + 1 === block.number) {
        // if latest block in buffer is parent of current block, we can stop synchronizing
        if (firstUnconfirmedBlock.hash === block.parentHash) {
          blocks.push(block);
          break;
        }
        // remove last block from blocks buffer if there is parent hash mismatch,
        // because it means that block in buffer is not valid anymore
        this.blocksBuffer.popNewest();
      }

      blocks.push(block);

      await sleep(this.pullBlocksLoopIntervalMs);
    }
    // if there are blocks in array, check if first one number is +1 of latest confirmed block 
    // and if hashes do not match throw fatal error, because it means that we have a fork on confirmed block
    if (this.latestConfirmedBlock && blocks.length > 0) {
      const block = blocks[blocks.length - 1];
      if (this.latestConfirmedBlock.number + 1 === block.number && this.latestConfirmedBlock.hash !== block.parentHash) {
        throw new FatalIndexerError(`Confirmed block parent hash mismatch for block ${block.number} while synchronizing from last block - expected parent hash ${this.latestConfirmedBlock.hash}, got ${block.parentHash}`);
      }
    }

    // add from last to first, so we can process them in correct order from first to last
    let hasNewConfirmedBlock = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const nb = this.addBlock(blocks[i]);
      hasNewConfirmedBlock ||= nb;
    }

    return hasNewConfirmedBlock
  }

  private addBlock(block: Block): boolean {
    this.blocksBuffer.push(block);
    if (!this.blocksBuffer.isFull()) {
      return false;
    }
    // retrieve the oldest block in buffer, which is the one that got confirmed, and save it to database
    const confirmedBlock = this.blocksBuffer.peek()!;
    try {
      this.db.insertBlock(confirmedBlock);
    } catch (e) {
      // undo the push: only this method drains the buffer, so leaving it full
      // would make every later addBlock throw 'buffer is full' forever
      this.blocksBuffer.popNewest();
      throw e;
    }
    this.latestConfirmedBlock = confirmedBlock;
    this.blocksBuffer.pop(); // remove confirmed block from buffer
    this.logger.info({ number: confirmedBlock.number, hash: confirmedBlock.hash }, 'Confirmed block');
    return true;
  }

  private getLatestBlock(): Block | null {
    const newestBlock = this.blocksBuffer.peekNewest();
    return newestBlock ? newestBlock : this.latestConfirmedBlock;
  }
}