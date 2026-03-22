/**
 * terminal-filter.ts - Terminal entropy filter for NREKI.
 *
 * Filters noisy terminal output (npm errors, test failures, build logs)
 * to extract only actionable information. Typical savings: 90-98% on
 * error output from failed builds or test runs.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface ErrorSummary {
    errorCount: number;
    uniqueErrors: string[];
    firstError: string | null;
    affectedFiles: string[];
    summary: string;
}

export interface FilterResult {
    original_tokens: number;
    filtered_tokens: number;
    reduction_percent: number;
    error_summary: ErrorSummary;
    filtered_text: string;
}

// ─── ANSI Stripping ─────────────────────────────────────────────────

// Matches all ANSI escape sequences: CSI (ESC[), OSC (ESC]), and SGR params
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]|\x1b\[[\d;]*m/g;

export function stripAnsiCodes(text: string): string {
    return text.replace(ANSI_RE, "");
}

// ─── Line Normalization (for near-duplicate detection) ──────────────

function normalizeLine(line: string): string {
    // Only normalize line:col numbers in non-user paths (node_modules, internal, anonymous)
    // to avoid collapsing genuinely different user source errors
    if (line.includes("node_modules") ||
        line.includes("internal/") ||
        line.includes("<anonymous>")) {
        return line
            .replace(/:\d+:\d+/g, ":L:C")          // line:col numbers
            .replace(/0x[a-fA-F0-9]+/gi, "0xADDR") // memory addresses
            .replace(/\d{13,}/g, "TIMESTAMP")       // epoch timestamps
            .replace(/:\d+\)/g, ":N)")              // single line numbers
            .trim();
    }
    // User source lines: only normalize memory addresses and timestamps
    return line
        .replace(/0x[a-fA-F0-9]+/gi, "0xADDR")
        .replace(/\d{13,}/g, "TIMESTAMP")
        .trim();
}

// ─── Line Deduplication ─────────────────────────────────────────────

export function deduplicateLines(lines: string[]): string[] {
    if (lines.length === 0) return [];

    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const current = lines[i];

        // Count consecutive duplicates of this exact line
        let count = 1;
        while (i + count < lines.length && lines[i + count] === current) {
            count++;
        }

        if (count > 2) {
            // Keep line once, note repetitions
            result.push(current);
            result.push(`  [repeated ${count - 1} more times]`);
            i += count;
            continue;
        }

        // Check for repeating blocks: find if lines[i..i+blockLen) repeats
        let blockCollapsed = false;
        if (i + 3 <= lines.length) {
            for (let blockLen = 3; blockLen <= Math.min(20, Math.floor((lines.length - i) / 2)); blockLen++) {
                let repeats = 1;
                let j = i + blockLen;
                while (j + blockLen <= lines.length) {
                    let matches = true;
                    for (let k = 0; k < blockLen; k++) {
                        if (lines[j + k] !== lines[i + k]) {
                            matches = false;
                            break;
                        }
                    }
                    if (!matches) break;
                    repeats++;
                    j += blockLen;
                }

                if (repeats >= 2) {
                    // Show block once, note repetitions
                    for (let k = 0; k < blockLen; k++) {
                        result.push(lines[i + k]);
                    }
                    result.push(`  [block repeated ${repeats} times, showing once]`);
                    i += blockLen * repeats;
                    blockCollapsed = true;
                    break;
                }
            }
        }

        if (!blockCollapsed) {
            result.push(current);
            i += count; // skip any duplicates (1 or 2)
            if (count === 2) {
                result.push(current);
            }
        }
    }

    // Second pass: normalize-based dedup for near-duplicates
    // (e.g., stack traces differing only in line numbers or addresses)
    const seen = new Set<string>();
    return result.filter(line => {
        const normalized = normalizeLine(line);
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
    });
}

// ─── Node Modules Filtering ────────────────────────────────────────

const NODE_MODULES_RE = /^\s+at\s+.*node_modules[/\\]/;
const INTERNAL_RE = /^\s+at\s+.*\((?:node:|internal\/)/;

export function filterNodeModules(lines: string[]): string[] {
    const result: string[] = [];
    let collapsedCount = 0;

    for (const line of lines) {
        if (NODE_MODULES_RE.test(line) || INTERNAL_RE.test(line)) {
            collapsedCount++;
            continue;
        }

        // Flush collapsed count before a non-collapsed line
        if (collapsedCount > 0) {
            result.push(`  [${collapsedCount} frames in node_modules/internal]`);
            collapsedCount = 0;
        }

        result.push(line);
    }

    // Flush remaining
    if (collapsedCount > 0) {
        result.push(`  [${collapsedCount} frames in node_modules/internal]`);
    }

    return result;
}

// ─── Error Summary Extraction ───────────────────────────────────────

// Common error patterns
const TS_ERROR_RE = /error TS(\d+):\s*(.+)/;
const JEST_FAIL_RE = /(?:FAIL|✕|×|✗)\s+(.+)/;
const VITEST_FAIL_RE = /(?:FAIL|×)\s+(tests?\/.+|src\/.+)/;
const NODE_ERROR_RE = /^(\w*Error):\s*(.+)/;
const NPM_ERR_RE = /^npm (?:ERR!|error)\s*(.+)/i;
const FILE_PATH_RE = /(?:^|\s)((?:src|lib|test|tests|app)\/[\w/.-]+\.\w+)/g;

export function extractErrorSummary(text: string): ErrorSummary {
    const lines = text.split("\n");
    const uniqueErrors = new Set<string>();
    const affectedFiles = new Set<string>();
    let firstError: string | null = null;

    for (const line of lines) {
        let match;

        // TypeScript errors
        match = TS_ERROR_RE.exec(line);
        if (match) {
            const err = `TS${match[1]}: ${match[2].trim()}`;
            uniqueErrors.add(err);
            if (!firstError) firstError = err;
        }

        // Node/runtime errors
        match = NODE_ERROR_RE.exec(line);
        if (match) {
            const err = `${match[1]}: ${match[2].trim()}`;
            uniqueErrors.add(err);
            if (!firstError) firstError = err;
        }

        // npm errors
        match = NPM_ERR_RE.exec(line);
        if (match) {
            const err = `npm: ${match[1].trim()}`;
            uniqueErrors.add(err);
            if (!firstError) firstError = err;
        }

        // Jest/Vitest failures
        match = JEST_FAIL_RE.exec(line) || VITEST_FAIL_RE.exec(line);
        if (match) {
            const err = `FAIL: ${match[1].trim()}`;
            uniqueErrors.add(err);
            if (!firstError) firstError = err;
        }

        // Extract affected file paths
        let fileMatch;
        while ((fileMatch = FILE_PATH_RE.exec(line)) !== null) {
            affectedFiles.add(fileMatch[1]);
        }
    }

    const errorCount = uniqueErrors.size;
    const uniqueList = [...uniqueErrors].sort();
    const fileList = [...affectedFiles].sort();

    let summary: string;
    if (errorCount === 0) {
        summary = "No structured errors detected in output.";
    } else if (errorCount === 1) {
        summary = `1 error: ${uniqueList[0]}`;
    } else {
        summary = `${errorCount} unique errors. First: ${firstError}`;
    }

    return {
        errorCount,
        uniqueErrors: uniqueList,
        firstError,
        affectedFiles: fileList,
        summary,
    };
}

// ─── Main Filter Pipeline ───────────────────────────────────────────

/** Estimate token count using ~3.5 chars/token for terminal output. */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
}

export function filterTerminalOutput(
    raw: string,
    maxLines: number = 100
): FilterResult {
    if (!raw || raw.trim().length === 0) {
        return {
            original_tokens: 0,
            filtered_tokens: 0,
            reduction_percent: 0,
            error_summary: {
                errorCount: 0,
                uniqueErrors: [],
                firstError: null,
                affectedFiles: [],
                summary: "Empty input.",
            },
            filtered_text: "",
        };
    }

    const originalTokens = estimateTokens(raw);

    // Pipeline: strip ANSI → split → deduplicate → filter node_modules
    const stripped = stripAnsiCodes(raw);
    const lines = stripped.split("\n");
    const deduped = deduplicateLines(lines);
    const filtered = filterNodeModules(deduped);

    // Truncate to max lines
    let finalLines = filtered;
    let truncated = false;
    if (finalLines.length > maxLines) {
        finalLines = finalLines.slice(0, maxLines);
        truncated = true;
    }

    // Extract error summary from the cleaned (but not truncated) text
    const errorSummary = extractErrorSummary(stripped);

    // Build final output
    let filteredText = finalLines.join("\n");
    if (truncated) {
        filteredText += `\n  [... truncated to ${maxLines} lines, ${filtered.length - maxLines} lines omitted]`;
    }

    const filteredTokens = estimateTokens(filteredText);
    const reductionPercent = originalTokens > 0
        ? Math.round((1 - filteredTokens / originalTokens) * 100)
        : 0;

    return {
        original_tokens: originalTokens,
        filtered_tokens: filteredTokens,
        reduction_percent: Math.max(0, reductionPercent),
        error_summary: errorSummary,
        filtered_text: filteredText,
    };
}
