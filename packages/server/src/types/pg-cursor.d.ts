declare module 'pg-cursor' {
  import type { Submittable } from 'pg';

  export interface CursorQueryConfig {
    rowMode?: 'array' | 'object';
  }

  export default class Cursor implements Submittable {
    constructor(text: string, values?: unknown[], config?: CursorQueryConfig);
    read(rowCount: number, callback: (err: Error | null, rows: unknown[]) => void): void;
    read(rowCount: number): Promise<unknown[]>;
    close(callback: (err: Error | null) => void): void;
    close(): Promise<void>;
  }
}
