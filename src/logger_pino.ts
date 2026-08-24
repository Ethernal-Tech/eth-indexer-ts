import pino from 'pino';
import { ILogger } from './interfaces/logger';

export type PinoLoggerOptions = {  
  level: string;
  /** Write human-readable output to stdout (default: false → JSON) */
  pretty: boolean;
  /** Path to log file. Supports date tokens, e.g. ./logs/app.%Y-%m-%d.log */
  file?: string;
  /** Max file size before rotation, e.g. '10m', '100m' (pino-roll syntax) */
  fileSize?: string;
  /** Rotation frequency: 'daily' | 'hourly' (pino-roll syntax) */
  fileFrequency?: 'daily' | 'hourly';
  /** Max number of rotated files to keep (0 = unlimited) */
  fileMaxFiles?: number;
}

export class PinoLogger implements ILogger {
  private readonly logger: pino.Logger;

  constructor(opts: PinoLoggerOptions) {
    const targets: pino.TransportTargetOptions[] = [];

    // stdout — always present, pretty or plain JSON
    targets.push(
      opts.pretty
        ? { target: 'pino-pretty', level: opts.level, options: { colorize: true, destination: 1 } }
        : { target: 'pino/file', level: opts.level, options: { destination: 1 } }
    );

    // optional file sink with rotation via pino-roll
    if (opts.file) {
      targets.push({
        target: 'pino-roll',
        level: opts.level,
        options: {
          file: opts.file,
          mkdir: true,
          ...(opts.fileSize ? { size: opts.fileSize } : {}),
          ...(opts.fileFrequency ? { frequency: opts.fileFrequency } : {}),
          ...(opts.fileMaxFiles ? { limit: { count: opts.fileMaxFiles } } : {}),
        },
      });
    }

    this.logger = pino(
      { level: opts.level },
      pino.transport({ targets }),
    );
  }

  trace(obj: object | string, msg?: string): void {
    if (typeof obj === 'string') {
      this.logger.trace(obj);
    } else {
      this.logger.trace(obj, msg!);
    }
  }

  debug(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.debug(objOrMsg);
    } else {
      this.logger.debug(objOrMsg, msg!);
    }
  }

  info(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.info(objOrMsg);
    } else {
      this.logger.info(objOrMsg, msg!);
    }
  }

  warn(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.warn(objOrMsg);
    } else {
      this.logger.warn(objOrMsg, msg!);
    }
  }

  error(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.error(objOrMsg);
    } else {
      this.logger.error(objOrMsg, msg!);
    }
  }

  fatal(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.fatal(objOrMsg);
    } else {
      this.logger.fatal(objOrMsg, msg!);
    }
  }
}
