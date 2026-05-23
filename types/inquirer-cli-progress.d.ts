declare module 'inquirer' {
  export function prompt<T = any>(questions: any): Promise<T>;
}

declare module 'cli-progress' {
  export class SingleBar {
    constructor(options?: any);
    start(total: number, startValue: number): void;
    update(current: number): void;
    stop(): void;
  }
}

declare module 'better-sqlite3' {
  const Database: any;
  export = Database;
}

declare module '*.json' {
  const value: any;
  export = value;
}
