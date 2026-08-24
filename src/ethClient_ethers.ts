import { AbstractProvider, Block as EthersBlock, Log } from 'ethers';
import { Block, BlockNumberType, ReceiptLog } from './common/data';
import { IEthClient } from './interfaces/ethClient';

export class EthersEthClient implements IEthClient {
  private readonly provider: AbstractProvider;
  private readonly latestBlockStrategy: BlockNumberType;

  constructor(provider: AbstractProvider, latestBlockStrategy: BlockNumberType) {
    this.provider = provider;
    this.latestBlockStrategy = latestBlockStrategy;
  }

  async getBlockByNumber(num: number): Promise<Block | null> {
    const block = await this.provider.getBlock(num);
    return toBlock(block);
  }

  async getLatestBlock(): Promise<Block | null> {
    const block = await this.provider.getBlock(this.latestBlockStrategy);
    return toBlock(block);
  }

  async getLogs(
    fromBlock: number,
    toBlock: number,
    address?: string[],
    topics?: (string | string[])[],
  ): Promise<ReceiptLog[]> {
    const logs = await this.provider.getLogs({
      address,
      topics,
      fromBlock,
      toBlock
    });
    return logs.map((l: Log) => ({
      address: l.address,
      topics: Array.isArray(l.topics) ? l.topics.map(String) : [],
      data: l.data,
      txIndex: l.transactionIndex,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
      logIndex: l.index,
    }));
  }
}

export default EthersEthClient;

function toBlock(block: EthersBlock | null): Block | null {
  if (!block) {
    return null;
  }
  return {
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
    txHashes: block.transactions
  } as Block;
}