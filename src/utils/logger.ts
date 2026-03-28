/**
 * logger.ts — Lightweight stderr-only logger with structured output
 *
 * MCP requires stdout to be EXCLUSIVELY JSON-RPC.
 * All diagnostic output goes through process.stderr.write().
 * Zero external dependencies (no winston, no pino).
 *
 * NREKI_DEBUG=1      enables debug-level output.
 * NREKI_LOG_FORMAT=json  outputs JSON lines for machine parsing.
 */

const iso = (): string => new Date().toISOString();
const compact = (): string => iso().slice(11, 23); // HH:MM:SS.mmm
const isJson = process.env.NREKI_LOG_FORMAT === "json";

// ─── Transaction context (set per interceptAtomicBatch) ──────────
let _txId = "";
export function setTxId(id: string): void { _txId = id; }
export function clearTxId(): void { _txId = ""; }

function emit(level: string, msg: string, trace?: string): void {
    if (isJson) {
        const obj: Record<string, string> = { level, ts: iso(), msg };
        if (_txId) obj.txId = _txId;
        if (trace) obj.trace = trace;
        process.stderr.write(JSON.stringify(obj) + "\n");
    } else {
        const tx = _txId ? ` tx:${_txId}` : "";
        const suffix = trace ?? "";
        process.stderr.write(`[NREKI:${level} ${compact()}${tx}] ${msg}${suffix}\n`);
    }
}

export const logger = {
    info: (msg: string): void => {
        emit("INFO", msg);
    },
    warn: (msg: string): void => {
        emit("WARN", msg);
    },
    error: (msg: string, err?: unknown): void => {
        const trace = err instanceof Error ? ` ${err.stack}` : (err ? ` ${err}` : "");
        emit("ERROR", msg, trace || undefined);
    },
    debug: (msg: string): void => {
        if (process.env.NREKI_DEBUG) emit("DEBUG", msg);
    },
};
