declare module 'base45' {
  export function encode(input: Uint8Array | Buffer): string;
  export function decode(input: string): Buffer;
}

declare module 'cbor' {
  export function encode(input: any): Buffer;
  export class Tagged {
    constructor(tag: number, value: any);
  }
}

declare module 'node-cron' {
  export interface ScheduledTask {
    stop(): void;
  }
  export function schedule(expression: string, callback: () => void): ScheduledTask;
}

declare module 'pako' {
  export function deflate(input: Uint8Array | Buffer | string): Uint8Array;
}
