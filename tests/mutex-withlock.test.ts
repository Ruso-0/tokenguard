import { describe, it, expect } from "vitest";
import { AsyncMutex } from "../src/kernel/nreki-kernel.js";

describe("AsyncMutex.withLock", () => {
    it("should execute fn and return its result", async () => {
        const mutex = new AsyncMutex();
        const result = await mutex.withLock(async () => 42);
        expect(result).toBe(42);
    });

    it("should release lock even when fn throws", async () => {
        const mutex = new AsyncMutex();
        await expect(
            mutex.withLock(async () => { throw new Error("boom"); })
        ).rejects.toThrow("boom");
        const result = await mutex.withLock(async () => "recovered");
        expect(result).toBe("recovered");
    });

    it("should reject queued callers on queue timeout", async () => {
        const mutex = new AsyncMutex();
        // First caller holds the lock forever (simulates livelock)
        const _holder = mutex.withLock(() => new Promise(() => {}));
        // Second caller should timeout waiting in the queue
        await expect(
            mutex.lock(100).then(unlock => { unlock(); return "got-lock"; })
        ).rejects.toThrow("queue timeout");
    });

    it("should serialize concurrent withLock calls", async () => {
        const mutex = new AsyncMutex();
        const order: number[] = [];
        const p1 = mutex.withLock(async () => {
            await new Promise(r => setTimeout(r, 50));
            order.push(1);
        });
        const p2 = mutex.withLock(async () => {
            order.push(2);
        });
        await Promise.all([p1, p2]);
        expect(order).toEqual([1, 2]);
    });

    it("should support synchronous fn", async () => {
        const mutex = new AsyncMutex();
        const result = await mutex.withLock(() => "sync-value");
        expect(result).toBe("sync-value");
    });
});
