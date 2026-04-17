/**
 * Type declarations for sql.js.
 * sql.js exposes SQLite compiled to WASM with a synchronous API
 * once initialized (init is async).
 */

declare module "sql.js" {
    /** SQLite's canonical value types (per SQLite type affinity spec). */
    export type SqlValue = string | number | boolean | Uint8Array | null;

    export interface SqlJsStatic {
        Database: {
            new(): Database;
            new(data?: ArrayLike<number> | Buffer | null): Database;
        };
    }

    export interface QueryExecResult {
        columns: string[];
        values: SqlValue[][];
    }

    export interface Statement {
        bind(params?: SqlValue[]): boolean;
        step(): boolean;
        getAsObject(params?: SqlValue[]): Record<string, SqlValue>;
        get(params?: SqlValue[]): SqlValue[];
        free(): boolean;
        reset(): void;
        run(params?: SqlValue[]): void;
    }

    export interface Database {
        run(sql: string, params?: SqlValue[]): Database;
        exec(sql: string, params?: SqlValue[]): QueryExecResult[];
        prepare(sql: string): Statement;
        export(): Uint8Array;
        close(): void;
        getRowsModified(): number;
    }

    export default function initSqlJs(config?: {
        locateFile?: (file: string) => string;
    }): Promise<SqlJsStatic>;
}
