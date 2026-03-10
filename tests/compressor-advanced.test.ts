/**
 * compressor-advanced.test.ts — Tests for the LLMLingua-2-inspired compressor.
 *
 * Tests cover:
 * - Stage 1: Preprocessing (comments, console.log, whitespace)
 * - Stage 2: Self-information token scoring and filtering
 * - Stage 3: Structural compression (function body stripping)
 * - All three compression levels (light, medium, aggressive)
 * - Natural text compression
 */

import { describe, it, expect } from "vitest";
import {
    AdvancedCompressor,
    preprocess,
    scoreTokens,
    filterTokens,
    type CompressionLevel,
} from "../src/compressor-advanced.js";

// ─── Test Fixtures ───────────────────────────────────────────────────

const SAMPLE_TS_CODE = `
import { Request, Response } from 'express';

/**
 * Handles user authentication.
 * This is a very important service.
 */
export class AuthService {
  private users: Map<string, string> = new Map();

  // Authenticate a user with username and password
  async authenticate(username: string, password: string): Promise<boolean> {
    console.log('Authenticating user:', username);
    const stored = this.users.get(username);
    if (!stored) return false;
    console.debug('Found stored password');
    return stored === password;
  }

  async register(username: string, password: string): Promise<void> {
    if (this.users.has(username)) {
      throw new Error('User already exists');
    }
    console.info('Registering new user:', username);
    this.users.set(username, password);
  }

  // Delete a user from the system
  async deleteUser(username: string): Promise<boolean> {
    debugger;
    console.log('Deleting user:', username);
    return this.users.delete(username);
  }
}

export function createMiddleware(service: AuthService) {
  return async (req: Request, res: Response, next: Function) => {
    const token = req.headers.authorization;
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
`;

const SAMPLE_PROSE = `
The TokenGuard system is a comprehensive tool that provides various features
for optimizing token consumption in large language model interactions. It uses
a combination of semantic search, AST-based compression, and proactive monitoring
to reduce the number of tokens consumed during a coding session. The system
includes multiple modules that work together to achieve this goal, including
a vector index for semantic similarity search, a keyword index for BM25 matching,
and a hybrid search system that combines both approaches using Reciprocal Rank
Fusion. Additionally, the system provides a pre-tool-use hook that intercepts
file read operations and suggests more efficient alternatives, as well as a
token monitor that tracks burn rate and predicts budget exhaustion.
`;

const SAMPLE_PYTHON = `
# This module handles data processing
import os
import json
from typing import List, Dict, Optional

class DataProcessor:
    """
    A comprehensive data processor that handles various data formats.
    Supports JSON, CSV, and custom binary formats.
    """

    def __init__(self, config: Dict):
        self.config = config
        self.data = []
        print("DataProcessor initialized")

    def process(self, items: List[Dict]) -> List[Dict]:
        # Process each item in the list
        results = []
        for item in items:
            print(f"Processing item: {item}")
            result = self._transform(item)
            results.append(result)
        return results

    def _transform(self, item: Dict) -> Dict:
        """Transform a single data item."""
        return {k: str(v) for k, v in item.items()}
`;

// ─── Preprocessing Tests (Stage 1) ──────────────────────────────────

describe("Preprocessing (Stage 1)", () => {
    it("should strip single-line comments", () => {
        const { cleaned } = preprocess(
            "const x = 1; // this is a comment\nconst y = 2;",
            "test.ts"
        );
        expect(cleaned).not.toContain("// this is a comment");
        expect(cleaned).toContain("const x = 1;");
        expect(cleaned).toContain("const y = 2;");
    });

    it("should strip multi-line comments", () => {
        const { cleaned } = preprocess(
            "/* multi\nline\ncomment */\nconst x = 1;",
            "test.ts"
        );
        expect(cleaned).not.toContain("multi");
        expect(cleaned).not.toContain("comment");
        expect(cleaned).toContain("const x = 1;");
    });

    it("should strip JSDoc comments", () => {
        const { cleaned } = preprocess(
            "/** @param {string} name */\nfunction greet(name) {}",
            "test.ts"
        );
        expect(cleaned).not.toContain("@param");
        expect(cleaned).toContain("function greet(name)");
    });

    it("should strip console.log statements", () => {
        const { cleaned } = preprocess(
            "console.log('hello');\nconst x = 1;\nconsole.error('fail');",
            "test.ts"
        );
        expect(cleaned).not.toContain("console.log");
        expect(cleaned).not.toContain("console.error");
        expect(cleaned).toContain("const x = 1;");
    });

    it("should strip debugger statements", () => {
        const { cleaned } = preprocess(
            "debugger;\nconst x = 1;\ndebugger",
            "test.ts"
        );
        expect(cleaned).not.toContain("debugger");
        expect(cleaned).toContain("const x = 1;");
    });

    it("should collapse consecutive empty lines", () => {
        const { cleaned } = preprocess(
            "line1\n\n\n\n\nline2",
            "test.ts"
        );
        // Should have at most one blank line between
        expect(cleaned).not.toMatch(/\n{3,}/);
        expect(cleaned).toContain("line1");
        expect(cleaned).toContain("line2");
    });

    it("should strip Python comments and docstrings", () => {
        const { cleaned } = preprocess(SAMPLE_PYTHON, "script.py");
        expect(cleaned).not.toContain("# This module handles");
        expect(cleaned).not.toContain("# Process each item");
        expect(cleaned).not.toContain('"""');
        expect(cleaned).not.toContain("A comprehensive data processor");
        expect(cleaned).toContain("import os");
        expect(cleaned).toContain("class DataProcessor:");
    });

    it("should strip Python print statements", () => {
        const { cleaned } = preprocess(SAMPLE_PYTHON, "script.py");
        expect(cleaned).not.toContain('print("DataProcessor initialized")');
        expect(cleaned).not.toContain("print(f\"Processing item");
    });

    it("should report characters removed", () => {
        const content = "/* big comment */\nconst x = 1;";
        const { removed } = preprocess(content, "test.ts");
        expect(removed).toBeGreaterThan(0);
    });
});

// ─── Token Scoring Tests (Stage 2) ──────────────────────────────────

describe("Token Scoring (Stage 2)", () => {
    it("should assign low scores to common English words", () => {
        const scored = scoreTokens("the a is are was in for on", 0.7);
        const nonBreak = scored.filter(t => !t.lineBreak);
        // Common words should have LOW self-information (high probability)
        for (const t of nonBreak) {
            // Common words have high probability -> low self-info -> low score at alpha=0.7
            expect(t.score).toBeLessThan(15);
        }
    });

    it("should assign high scores to rare identifiers", () => {
        const scored = scoreTokens("calculateMerkleHash TokenGuardEngine", 0.7);
        const nonBreak = scored.filter(t => !t.lineBreak);
        // Rare tokens default to 0.0001 probability -> high self-info
        for (const t of nonBreak) {
            expect(t.score).toBeGreaterThan(5);
        }
    });

    it("should protect structural tokens", () => {
        const scored = scoreTokens("{ } ( ) = => ; : [ ]", 0.7);
        const nonBreak = scored.filter(t => !t.lineBreak);
        for (const t of nonBreak) {
            if (t.token.trim().length > 0) {
                expect(t.protected).toBe(true);
            }
        }
    });

    it("should protect tokens following keywords", () => {
        const scored = scoreTokens("function authenticate class UserService import express", 0.7);
        const nonBreak = scored.filter(t => !t.lineBreak);
        // authenticate, UserService, express follow keywords
        const authenticate = nonBreak.find(t => t.token === "authenticate");
        const userService = nonBreak.find(t => t.token === "UserService");
        expect(authenticate?.protected).toBe(true);
        expect(userService?.protected).toBe(true);
    });

    it("should protect PascalCase identifiers", () => {
        const scored = scoreTokens("MyComponent DataProcessor", 0.7);
        const nonBreak = scored.filter(t => !t.lineBreak);
        for (const t of nonBreak) {
            if (t.token.trim().length > 0) {
                expect(t.protected).toBe(true);
            }
        }
    });

    it("should protect numbers", () => {
        const scored = scoreTokens("42 3.14 100", 0.7);
        const nonBreak = scored.filter(t => !t.lineBreak);
        for (const t of nonBreak) {
            if (t.token.trim().length > 0) {
                expect(t.protected).toBe(true);
            }
        }
    });
});

// ─── Token Filtering Tests ──────────────────────────────────────────

describe("Token Filtering", () => {
    it("should remove fewer tokens at light level", () => {
        const text = "the very important and quite specific functionality of the system is basically used";
        const scored = scoreTokens(text, 0.3);
        const light = filterTokens(scored, "light");
        const aggressive = filterTokens(scored, "aggressive");
        expect(light.length).toBeGreaterThan(aggressive.length);
    });

    it("should preserve protected tokens at all levels", () => {
        const text = "function authenticate(username: string) { return true; }";
        const scored = scoreTokens(text, 0.7);

        for (const level of ["light", "medium", "aggressive"] as CompressionLevel[]) {
            const filtered = filterTokens(scored, level);
            expect(filtered).toContain("function");
            expect(filtered).toContain("authenticate");
            expect(filtered).toContain("{");
            expect(filtered).toContain("}");
        }
    });
});

// ─── Compression Level Tests ────────────────────────────────────────

describe("Compression Levels (static estimates)", () => {
    it("light should estimate ~50% reduction", () => {
        const est = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "light");
        expect(est.estimatedRatio).toBeCloseTo(0.50, 1);
        expect(est.estimatedTokensSaved).toBeGreaterThan(0);
    });

    it("medium should estimate ~75% reduction", () => {
        const est = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "medium");
        expect(est.estimatedRatio).toBeCloseTo(0.75, 1);
    });

    it("aggressive should estimate ~92% reduction", () => {
        const est = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "aggressive");
        expect(est.estimatedRatio).toBeCloseTo(0.92, 1);
    });

    it("should have increasing savings: light < medium < aggressive", () => {
        const light = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "light");
        const medium = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "medium");
        const aggressive = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "aggressive");
        expect(light.estimatedTokensSaved).toBeLessThan(medium.estimatedTokensSaved);
        expect(medium.estimatedTokensSaved).toBeLessThan(aggressive.estimatedTokensSaved);
    });
});

// ─── Natural Text Tests ─────────────────────────────────────────────

describe("Natural Text Compression", () => {
    it("should filter common English filler from prose", () => {
        const scored = scoreTokens(SAMPLE_PROSE, 0.5);
        const filtered = filterTokens(scored, "medium");
        // Should be shorter than original
        expect(filtered.length).toBeLessThan(SAMPLE_PROSE.length);
        // Should still contain important terms
        expect(filtered).toContain("TokenGuard");
        expect(filtered).toContain("BM25");
    });

    it("should preserve technical terms in prose", () => {
        const scored = scoreTokens(SAMPLE_PROSE, 0.5);
        const filtered = filterTokens(scored, "aggressive");
        // Technical terms should survive even aggressive filtering
        expect(filtered).toContain("Reciprocal");
        expect(filtered).toContain("Rank");
        expect(filtered).toContain("Fusion");
    });
});

// ─── Preprocessing on Full Samples ──────────────────────────────────

describe("Full Sample Preprocessing", () => {
    it("should achieve significant reduction on commented TS code", () => {
        const { cleaned, removed } = preprocess(SAMPLE_TS_CODE, "auth.ts");
        // Should remove comments, console.log, debugger
        expect(cleaned).not.toContain("console.log");
        expect(cleaned).not.toContain("console.debug");
        expect(cleaned).not.toContain("console.info");
        expect(cleaned).not.toContain("debugger");
        expect(cleaned).not.toContain("Handles user authentication");
        expect(removed).toBeGreaterThan(100);
        // Should keep important code
        expect(cleaned).toContain("import");
        expect(cleaned).toContain("AuthService");
        expect(cleaned).toContain("authenticate");
    });

    it("should handle empty input gracefully", () => {
        const { cleaned, removed } = preprocess("", "empty.ts");
        expect(cleaned).toBe("");
        expect(removed).toBe(0);
    });

    it("should handle code with no comments", () => {
        const code = "const x = 1;\nconst y = 2;\n";
        const { cleaned } = preprocess(code, "clean.ts");
        expect(cleaned).toContain("const x = 1;");
        expect(cleaned).toContain("const y = 2;");
    });
});
