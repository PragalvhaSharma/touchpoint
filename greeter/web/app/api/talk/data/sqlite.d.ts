// node:sqlite ships with Node 22.5+, but this app's @types/node is 20; only what the data route uses.
declare module "node:sqlite" {
  export class StatementSync {
    all(...params: (string | number | bigint | null)[]): Record<string, unknown>[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
