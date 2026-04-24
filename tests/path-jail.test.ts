import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { safePath } from "../src/utils/path-jail.js";

describe("safePath root casing", () => {
    it.skipIf(process.platform !== "win32")("allows same-drive paths on Windows", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-path-jail-"));
        try {
            const child = path.join(root, "bar.ts");
            fs.writeFileSync(child, "export const ok = true;\n", "utf-8");

            expect(safePath(root, child)).toBe(path.resolve(child));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform !== "win32")("allows lower-case drive letter on Windows", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-path-jail-"));
        try {
            const child = path.join(root, "bar.ts");
            fs.writeFileSync(child, "export const ok = true;\n", "utf-8");

            const lowerDriveRoot = root.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
            const lowerDriveChild = child.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());

            expect(safePath(lowerDriveRoot, lowerDriveChild)).toBe(path.resolve(lowerDriveChild));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform !== "win32")("blocks sibling drive paths on Windows", () => {
        expect(() => safePath("D:/foo", "D:/bar")).toThrow("Path traversal blocked");
    });

    it.skipIf(process.platform === "win32")("keeps POSIX paths case-sensitive", () => {
        expect(() => safePath("/home/x", "/home/X/y")).toThrow("Path traversal blocked");
    });
});
