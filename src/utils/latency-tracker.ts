/**
 * latency-tracker.ts — Lightweight operation latency accumulator.
 *
 * Records timing for the last N operations and computes P50/P95/P99 percentiles.
 * Used by nreki_guard action:"status" to surface performance telemetry.
 * Zero external dependencies.
 */

const MAX_SAMPLES = 200;

interface LatencyEntry {
    op: string;
    ms: number;
    ts: number;
}

class LatencyTracker {
    private samples: LatencyEntry[] = [];

    record(op: string, ms: number): void {
        this.samples.push({ op, ms, ts: Date.now() });
        if (this.samples.length > MAX_SAMPLES) {
            this.samples.shift();
        }
    }

    getStats(op?: string): { count: number; p50: number; p95: number; p99: number; avg: number } | null {
        const filtered = op
            ? this.samples.filter(s => s.op === op)
            : this.samples;

        if (filtered.length === 0) return null;

        const sorted = filtered.map(s => s.ms).sort((a, b) => a - b);
        const n = sorted.length;

        return {
            count: n,
            p50: sorted[Math.floor(n * 0.50)] ?? 0,
            p95: sorted[Math.floor(n * 0.95)] ?? 0,
            p99: sorted[Math.floor(n * 0.99)] ?? 0,
            avg: Math.round(sorted.reduce((a, b) => a + b, 0) / n),
        };
    }

    getSummary(): string {
        const ops = new Set(this.samples.map(s => s.op));
        if (ops.size === 0) return "  No operations recorded yet.";

        const lines: string[] = [];
        for (const op of ops) {
            const stats = this.getStats(op);
            if (!stats) continue;
            lines.push(
                `     ${op}: ${stats.count} ops, avg=${stats.avg}ms, p50=${stats.p50}ms, p95=${stats.p95}ms, p99=${stats.p99}ms`
            );
        }
        return lines.join("\n");
    }
}

// Singleton
export const latencyTracker = new LatencyTracker();
