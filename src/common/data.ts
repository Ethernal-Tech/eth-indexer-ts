export type Block = {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  txHashes: string[];
};

export type LogEvent = {
  id: number;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  txIndex: number;
  address: string;
  topics: string[];
  data: string;
};

export type ReceiptLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  txIndex: number;
};

export enum BlockNumberType {
  Safe = 'safe',
  Finalized = 'finalized',
  Latest = 'latest',
}
