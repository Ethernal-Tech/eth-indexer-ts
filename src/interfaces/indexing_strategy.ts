import { LogEvent } from '../common/data';

/** One polling loop the indexer drives: `run` once per tick, `intervalMs` between ticks. */
export type IndexerLoop = {
  name: string;
  intervalMs: number;
  /** Resolves with the logs stored on this tick, if any, for the new-log callback. */
  run(signal: AbortSignal): Promise<LogEvent[] | undefined>;
};

export interface IIndexingStrategy {
  init(): Promise<void>;
  loops(): IndexerLoop[];
}
