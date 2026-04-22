/**
 * audit.ts — Architecture Health Index (AHI)
 *
 * Deterministic architectural audit. Not an opinion — a measurement.
 * Combines 5 signals no other tool has:
 *   1. Spectral Integrity (λ₂) — is the project about to fracture?
 *   2. Bus Factor (PageRank concentration) — does one file hold all the power?
 *   3. Type Safety (error density) — how clean is the type system?
 *   4. Core Coverage — do critical files have tests?
 *   5. Stability (Chronos CFI) — which core files break chronically?
 *
 * Auto-scales: Deep Audit (5 signals) if kernel is booted, Fast Audit (3 signals) if not.
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import * as fs from "fs";
import * as path from "path";
import { SpectralMath, type SparseEdge } from "./kernel/spectral-topology.js";
import { computePageRank, type DependencyGraph } from "./repo-map.js";
import type { NrekiKernel } from "./kernel/nreki-kernel.js";
import type { ChronosMemory } from "./chronos-memory.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface AuditIssue {
    file: string;
    severity: "critical" | "high" | "medium" | "low";
    type: string;
    detail: string;
    action: string;
    impactOnScore: number;
}

export interface AuditComponent {
    name: string;
    score: number;
    weight: number;
    label: string;
    detail: string;
    available: boolean;
}

export interface AuditReport {
    ahi: number;
    level: "CRITICAL" | "POOR" | "FAIR" | "GOOD" | "HEALTHY";
    mode: "fast" | "deep";
    components: AuditComponent[];
    issues: AuditIssue[];
    recoveryPlan: string;
    filesAnalyzed: number;
    coreFiles: string[];
    timestamp: string;
    engine_version: string;
}

// ─── Score Helpers ──────────────────────────────────────────────────

function bucketScore(value: number, thresholds: [number, number, number]): number {
    const [t0, t1, t2] = thresholds;
    // thresholds descending: t0 > t1 > t2 (e.g., [0.90, 0.70, 0.40])
    if (value >= t0) return 1.0;
    if (value >= t1) return 0.7 + 0.3 * ((value - t1) / (t0 - t1));
    if (value >= t2) return 0.4 + 0.3 * ((value - t2) / (t1 - t2));
    // Below t2: linear decay toward 0.1 clamp
    return Math.max(0.1, 0.4 - 0.3 * ((t2 - value) / (t1 - t2)));
}

function bucketScoreInverse(value: number, thresholds: [number, number, number]): number {
    const [t0, t1, t2] = thresholds;
    // thresholds ascending: t0 < t1 < t2 (e.g., [0.05, 0.15, 0.50])
    if (value <= t0) return 1.0;
    if (value <= t1) return 1.0 - 0.3 * ((value - t0) / (t1 - t0));
    if (value <= t2) return 0.7 - 0.3 * ((value - t1) / (t2 - t1));
    // Above t2: linear decay toward 0.1 clamp
    return Math.max(0.1, 0.4 - 0.3 * ((value - t2) / (t2 - t1)));
}

function scoreToLabel(score: number): string {
    if (score >= 0.9) return "HEALTHY";
    if (score >= 0.7) return "GOOD";
    if (score >= 0.4) return "FAIR";
    if (score >= 0.2) return "POOR";
    return "CRITICAL";
}

function ahiToLevel(ahi: number): AuditReport["level"] {
    if (ahi >= 8.0) return "HEALTHY";
    if (ahi >= 6.0) return "GOOD";
    if (ahi >= 4.0) return "FAIR";
    if (ahi >= 2.0) return "POOR";
    return "CRITICAL";
}

// ─── Test Detection ─────────────────────────────────────────────────

const TEST_PATTERNS = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx", ".test.js", ".spec.js", ".test.mts", ".spec.mts", ".test.mjs", ".spec.mjs"];
const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next", "__pycache__", ".nreki", ".turbo", ".vercel", ".svelte-kit"]);

function findTestFiles(projectRoot: string): Set<string> {
    const testFiles = new Set<string>();
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!IGNORE_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
                continue;
            }
            if (TEST_PATTERNS.some(p => entry.name.endsWith(p))) {
                testFiles.add(path.join(dir, entry.name));
            }
        }
    };
    walk(projectRoot);
    return testFiles;
}

/** Cached test file heads — avoids O(N*M) readFileSync calls across core files. */
const testHeadCache = new Map<string, string>();

function fileHasTest(filePath: string, _projectRoot: string, testFiles: Set<string>): boolean {
    const baseName = path.basename(filePath).replace(/\.(ts|tsx|js|jsx)$/, "");
    for (const testFile of testFiles) {
        const testBase = path.basename(testFile);
        if (testBase.startsWith(baseName + ".test.") || testBase.startsWith(baseName + ".spec.")) {
            return true;
        }
        try {
            let head = testHeadCache.get(testFile);
            if (head === undefined) {
                head = fs.readFileSync(testFile, "utf-8").split("\n").slice(0, 50).join("\n");
                testHeadCache.set(testFile, head);
            }

            // Strip comments to prevent LLM gaming via `// import Foo`.
            const cleanHead = head
                .replace(/\/\*[\s\S]*?\*\//g, "") // Block comments
                .replace(/\/\/.*/g, "");          // Line comments

            const safeBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

            // Match from/require(/import(/import declarations — survives
            // multiline Prettier formatting because it targets the clause tail.
            const importPattern = new RegExp(
                `(?:from|require\\s*\\(|import\\s*\\(|import\\s+)['"\`][^'"\`]*\\b${safeBase}\\b[^'"\`]*['"\`]`
            );

            if (importPattern.test(cleanHead)) {
                return true;
            }
        } catch { /* skip */ }
    }
    return false;
}

// ─── Pure AHI Calculator (for simulation) ───────────────────────────

function calculateAHI(components: AuditComponent[]): number {
    const active = components.filter(c => c.weight > 0);
    const totalWeight = active.reduce((sum, c) => sum + c.weight, 0);
    if (totalWeight === 0) return 5.0;
    let raw = 0;
    for (const c of active) {
        raw += c.score * (c.weight / totalWeight);
    }
    return Math.round(raw * 100) / 10;
}

// ─── Main Audit ─────────────────────────────────────────────────────

export async function computeAudit(
    graph: DependencyGraph,
    allFiles: string[],
    projectRoot: string,
    kernel?: NrekiKernel,
    chronos?: ChronosMemory,
): Promise<AuditReport> {
    const isDeep = !!kernel?.isBooted();
    const issues: AuditIssue[] = [];
    const components: AuditComponent[] = [];

    const coreFiles = allFiles.filter(f => graph.tiers.get(f) === "core");

    // ═════════════════════════════════════════════════════════
    // SIGNAL 1: Spectral Integrity (Coupling Ratio)
    //
    // OLD: Φ = λ₂/N penalized modular projects (low λ₂ = good decoupling got 1/10)
    // NEW: Coupling Ratio = λ₂ / avgDegree
    //   Monolith: λ₂ ≈ avgDegree → ratio → 1.0 → LOW score (punished)
    //   Modular:  λ₂ << avgDegree → ratio → 0.0 → HIGH score (rewarded)
    // ═════════════════════════════════════════════════════════

    const nodeIndex = new Map<string, number>();
    allFiles.forEach((f, i) => nodeIndex.set(f, i));
    const N = allFiles.length;

    const sparseEdges: SparseEdge[] = [];
    for (const [targetFile, consumers] of graph.importedBy.entries()) {
        const targetIdx = nodeIndex.get(targetFile);
        if (targetIdx === undefined) continue;
        for (const consumer of consumers) {
            const consumerIdx = nodeIndex.get(consumer);
            if (consumerIdx !== undefined && consumerIdx !== targetIdx) {
                sparseEdges.push({ u: consumerIdx, v: targetIdx, weight: 1.0 });
            }
        }
    }

    let spectralScore = 0.5;
    let fiedlerValue = 0;
    let avgDegree = 0;
    let couplingRatio = 0;
    let topologyAvailable = false;

    if (N > 2 && sparseEdges.length > 0) {
        const spectral = SpectralMath.analyzeTopology(N, sparseEdges);

        if (spectral.fiedler !== undefined) {
            topologyAvailable = true;
            fiedlerValue = spectral.fiedler;
            avgDegree = (2 * sparseEdges.length) / N;
            couplingRatio = avgDegree > 0 ? fiedlerValue / avgDegree : 0;

            if (fiedlerValue === 0) {
                spectralScore = 0.1;
            } else {
                spectralScore = bucketScoreInverse(couplingRatio, [0.05, 0.15, 0.50]);
            }
        }
    } else if (N <= 2) {
        // Too small to measure — neutral
        topologyAvailable = true;
        spectralScore = 0.7;
    }

    components.push({
        name: "Spectral Integrity",
        score: spectralScore,
        weight: topologyAvailable ? 0.25 : 0.0,
        label: topologyAvailable ? scoreToLabel(spectralScore) : "N/A (graph skipped for mega-repo)",
        detail: topologyAvailable
            ? `λ₂ = ${fiedlerValue.toFixed(4)}, avgDegree = ${avgDegree.toFixed(2)}, coupling ratio = ${couplingRatio.toFixed(4)} (${N} files, ${sparseEdges.length} edges)`
            : `Repository too large (N>25000), spectral analysis skipped`,
        available: topologyAvailable,
    });

    if (fiedlerValue === 0 && N > 2 && sparseEdges.length > 0) {
        issues.push({
            file: "project-wide",
            severity: "critical",
            type: "spectral_fracture",
            detail: `λ₂ = 0. The dependency graph has disconnected components (dead code or orphan modules).`,
            action: "Identify disconnected clusters. Remove dead code or add interfaces between isolated modules.",
            impactOnScore: 0,
        });
    } else if (couplingRatio >= 0.5) {
        issues.push({
            file: "project-wide",
            severity: "critical",
            type: "spaghetti_coupling",
            detail: `Coupling ratio = ${couplingRatio.toFixed(3)}. The project is a monolith where most files are tightly interconnected.`,
            action: "Extract modules with clear interfaces. Reduce cross-cutting imports. Target coupling ratio < 0.15.",
            impactOnScore: 0,
        });
    }

    // ═════════════════════════════════════════════════════════
    // SIGNAL 2: Bus Factor (Shannon Entropy)
    //
    // OLD: concentration = top3PR / totalPR with hardcoded 15% threshold
    // NEW: Shannon Entropy normalized over PageRank distribution
    //   H = -Σ(p_i × ln(p_i)) / ln(N)
    //   H → 1.0 = Risk perfectly distributed (healthy republic)
    //   H → 0.0 = One file holds all the power (dictatorship / god file)
    // ═════════════════════════════════════════════════════════

    const prScores = computePageRank(allFiles, graph.importedBy);
    const sortedPR = Array.from(prScores.entries()).sort((a, b) => b[1] - a[1]);
    const totalPR = sortedPR.reduce((sum, [, v]) => sum + v, 0);

    let shannonEntropy = 0;
    if (totalPR > 0 && N > 1) {
        for (const [, pr] of sortedPR) {
            if (pr > 0) {
                const p = pr / totalPR;
                shannonEntropy -= p * Math.log(p);
            }
        }
    }
    const maxEntropy = N > 1 ? Math.log(N) : 1;
    const normalizedEntropy = maxEntropy > 0 ? shannonEntropy / maxEntropy : 1.0;

    // Score IS the entropy — no artificial buckets
    const busFactorScore = Math.min(1.0, Math.max(0.0, normalizedEntropy));

    components.push({
        name: "Bus Factor",
        score: busFactorScore,
        weight: 0.25,
        label: scoreToLabel(busFactorScore),
        detail: `Shannon entropy: ${normalizedEntropy.toFixed(3)} (1.0 = perfect distribution). Top 3: ${sortedPR.slice(0, 3).map(([f]) => path.basename(f)).join(", ")}`,
        available: true,
    });

    if (normalizedEntropy < 0.5) {
        for (const [file, pr] of sortedPR.slice(0, 3)) {
            const inDeg = graph.inDegree.get(file) || 0;
            if (totalPR > 0 && pr / totalPR > 0.15) {
                issues.push({
                    file,
                    severity: pr / totalPR > 0.30 ? "critical" : "high",
                    type: "bus_factor",
                    detail: `PageRank: ${pr.toFixed(3)} (${((pr / totalPR) * 100).toFixed(1)}% of total). ${inDeg} files depend on this.`,
                    action: `Split responsibilities. Extract interfaces to reduce coupling. ${inDeg} dependents will break if this file breaks.`,
                    impactOnScore: 0,
                });
            }
        }
    }

    // ═════════════════════════════════════════════════════════
    // SIGNAL 3: Type Safety (Deep mode only)
    // ═════════════════════════════════════════════════════════

    let typeSafetyScore = 0.5;
    let typeSafetyAvailable = false;

    if (isDeep && kernel) {
        typeSafetyAvailable = true;
        const errorCount = kernel.getCurrentErrorCount();
        const trackedFiles = kernel.getTrackedFiles();
        const errorDensity = trackedFiles > 0 ? errorCount / trackedFiles : 0;
        typeSafetyScore = bucketScoreInverse(errorDensity, [0.0, 0.05, 0.15]);

        if (errorCount > 0) {
            issues.push({
                file: "project-wide",
                severity: errorDensity > 0.15 ? "critical" : (errorDensity > 0.05 ? "high" : "medium"),
                type: "type_errors",
                detail: `${errorCount} type errors across ${trackedFiles} tracked files (density: ${errorDensity.toFixed(3)}).`,
                action: "Fix type errors in core files first. Use nreki_code action:\"edit\" with NREKI validation.",
                impactOnScore: 0,
            });
        }
    }

    components.push({
        name: "Type Safety",
        score: typeSafetyScore,
        weight: isDeep ? 0.20 : 0.0,
        label: typeSafetyAvailable ? scoreToLabel(typeSafetyScore) : "N/A (boot kernel for deep audit)",
        detail: typeSafetyAvailable
            ? `Error density: ${kernel!.getCurrentErrorCount()} errors / ${kernel!.getTrackedFiles()} files`
            : "Kernel not booted. Run with Claude Code for type safety analysis.",
        available: typeSafetyAvailable,
    });

    // ═════════════════════════════════════════════════════════
    // SIGNAL 4: Core Coverage (Test Detection)
    // ═════════════════════════════════════════════════════════

    const testFiles = findTestFiles(projectRoot);
    let coreWithTestsCount = 0;
    const untestedCoreFiles: Array<{ file: string; inDeg: number }> = [];

    for (const coreFile of coreFiles) {
        if (fileHasTest(path.join(projectRoot, coreFile), projectRoot, testFiles)) {
            coreWithTestsCount++;
        } else {
            untestedCoreFiles.push({
                file: coreFile,
                inDeg: graph.inDegree.get(coreFile) || 0,
            });
        }
    }

    const coreCoverage = coreFiles.length > 0 ? coreWithTestsCount / coreFiles.length : 1.0;
    const coreCoverageScore = bucketScore(coreCoverage, [0.90, 0.70, 0.40]);

    components.push({
        name: "Core Coverage",
        score: coreCoverageScore,
        weight: isDeep ? 0.20 : 0.30,
        label: scoreToLabel(coreCoverageScore),
        detail: `${coreWithTestsCount}/${coreFiles.length} core files have tests (${(coreCoverage * 100).toFixed(0)}%)`,
        available: true,
    });

    for (const { file, inDeg } of untestedCoreFiles) {
        issues.push({
            file,
            severity: inDeg > 20 ? "critical" : (inDeg > 5 ? "high" : "medium"),
            type: "untested_core",
            detail: `☢️ CRITICAL CORE file with ${inDeg} dependents and NO tests.`,
            action: `Add tests for ${path.basename(file)}. If this file breaks, ${inDeg} files break with it.`,
            impactOnScore: 0, // Will be computed by simulation below
        });
    }

    // ═════════════════════════════════════════════════════════
    // SIGNAL 5: Stability (Chronos CFI — Deep mode only)
    // ═════════════════════════════════════════════════════════

    let stabilityScore = 0.7;
    let stabilityAvailable = false;
    let sessionCount = 0;
    const fragileCore: Array<{ file: string; cfi: number }> = [];

    // B.4 Fix: Chronos Honeymoon check.
    // Require minimum 5 sessions of history before trusting Stability metric.
    try {
        const dbPath = path.join(projectRoot, ".nreki", "chronos-history.json");
        if (fs.existsSync(dbPath)) {
            const data = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
            sessionCount = data.currentSessionId || 0;
        }
    } catch {
        // Chronos history unavailable, stability stays unavailable
    }

    if (chronos && sessionCount >= 5) {
        stabilityAvailable = true;

        for (const coreFile of coreFiles) {
            const cfi = chronos.getFileCFI(coreFile);
            if (cfi >= chronos.CFI_ALERT_THRESHOLD) {
                fragileCore.push({ file: coreFile, cfi });
            }
        }

        if (fragileCore.length === 0) stabilityScore = 1.0;
        else if (fragileCore.length <= 2) stabilityScore = 0.7;
        else if (fragileCore.length <= 5) stabilityScore = 0.4;
        else stabilityScore = 0.1;

        for (const { file, cfi } of fragileCore) {
            issues.push({
                file,
                severity: cfi > 30 ? "critical" : "high",
                type: "chronic_fragility",
                detail: `CFI: ${cfi.toFixed(1)}. This core file breaks repeatedly across sessions.`,
                action: "Add regression tests targeting known failure patterns. Consider refactoring to reduce complexity.",
                impactOnScore: 0,
            });
        }
    }

    components.push({
        name: "Stability",
        score: stabilityScore,
        weight: isDeep && stabilityAvailable ? 0.10 : 0.0,
        label: stabilityAvailable ? scoreToLabel(stabilityScore) : "N/A (insufficient history)",
        detail: stabilityAvailable
            ? `Chronos sessions: ${sessionCount}, fragile core files: ${fragileCore.length}`
            : `Requires 5+ sessions. Current: ${sessionCount}.`,
        available: stabilityAvailable && isDeep,
    });

    // ═════════════════════════════════════════════════════════
    // COMPUTE AHI + SIMULATE RECOVERY (no more fiction)
    // ═════════════════════════════════════════════════════════

    const ahi = calculateAHI(components);

    // Sort issues by severity
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    issues.sort((a, b) => {
        const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (sevDiff !== 0) return sevDiff;
        return 0;
    });

    // ── RECOVERY SIMULATION ──────────────────────────────────
    // Instead of hardcoded impactOnScore, simulate each fix in RAM.
    // Clone the component scores, apply the virtual fix, recalculate AHI.
    // The delta is REAL math, not intuition.

    // Find coreCoverage component index for simulation
    const coreCoverageIdx = components.findIndex(c => c.name === "Core Coverage");

    for (const issue of issues) {
        if (issue.type === "untested_core" && coreCoverageIdx >= 0) {
            // Simulate: mark this file as tested, recalculate coreCoverage score
            const simulatedTestedCount = coreWithTestsCount + 1;
            const simulatedCoverage = coreFiles.length > 0 ? simulatedTestedCount / coreFiles.length : 1.0;
            const simulatedCoverageScore = bucketScore(simulatedCoverage, [0.90, 0.70, 0.40]);

            const simComponents = components.map((c, i) =>
                i === coreCoverageIdx ? { ...c, score: simulatedCoverageScore } : c
            );
            const simulatedAhi = calculateAHI(simComponents);
            issue.impactOnScore = Math.round((simulatedAhi - ahi) * 10) / 10;
        }
        // spectral_fracture, spaghetti_coupling, bus_factor, chronic_fragility:
        // Cannot simulate without modifying the graph structure.
        // impactOnScore stays 0 = "requires structural changes, impact not simulable"
    }

    // ── BUILD RECOVERY PLAN ─────────────────────────────────
    // Simulate ALL fixable issues applied together for cumulative projection
    const fixableIssues = issues.filter(i => i.impactOnScore > 0);

    let projectedAhi = ahi;
    if (fixableIssues.length > 0 && coreCoverageIdx >= 0) {
        const totalSimulatedTested = coreWithTestsCount + fixableIssues.filter(i => i.type === "untested_core").length;
        const totalSimCoverage = coreFiles.length > 0 ? totalSimulatedTested / coreFiles.length : 1.0;
        const totalSimCoverageScore = bucketScore(totalSimCoverage, [0.90, 0.70, 0.40]);
        const simComponents = components.map((c, i) =>
            i === coreCoverageIdx ? { ...c, score: totalSimCoverageScore } : c
        );
        projectedAhi = calculateAHI(simComponents);
    }

    const topIssues = issues.slice(0, 5);
    let recoveryPlan = "";

    if (topIssues.length > 0) {
        const hasSimulated = topIssues.some(i => i.impactOnScore > 0);
        const hasStructural = topIssues.some(i => i.impactOnScore === 0);

        if (hasSimulated) {
            recoveryPlan += `Simulated recovery: ${ahi.toFixed(1)} → ${projectedAhi.toFixed(1)} (computed in RAM, not estimated)\n\n`;
        }

        for (let i = 0; i < topIssues.length; i++) {
            const issue = topIssues[i];
            const icon = issue.severity === "critical" ? "🔴" : (issue.severity === "high" ? "🟠" : "🟡");
            const delta = issue.impactOnScore > 0 ? ` (+${issue.impactOnScore.toFixed(1)} simulated)` : " (structural — impact requires refactoring)";
            recoveryPlan += `${i + 1}. ${icon} ${issue.file}${delta}\n`;
            recoveryPlan += `   ${issue.detail}\n`;
            recoveryPlan += `   → ${issue.action}\n\n`;
        }

        if (hasStructural) {
            recoveryPlan += `Note: Structural issues (spectral, bus factor) cannot be simulated — they require architectural changes that modify the dependency graph.\n`;
        }
    } else {
        recoveryPlan = "No critical issues found. Your architecture is solid.";
    }

    return {
        ahi,
        level: ahiToLevel(ahi),
        mode: isDeep ? "deep" : "fast",
        components,
        issues,
        recoveryPlan,
        filesAnalyzed: allFiles.length,
        coreFiles,
        timestamp: new Date().toISOString(),
        engine_version: "v10.13-spectral-enriched",
    };
}

// ─── Format Report ──────────────────────────────────────────────────

export function formatAuditReport(report: AuditReport): string {
    const levelIcons: Record<string, string> = {
        CRITICAL: "🔴", POOR: "🟠", FAIR: "🟡", GOOD: "🟢", HEALTHY: "✅",
    };

    const icon = levelIcons[report.level] || "❓";
    const modeLabel = report.mode === "deep" ? "Deep Audit (5 signals)" : "Fast Audit (3 signals)";

    let text = "";
    text += `## NREKI Architecture Audit\n\n`;
    text += `╔══════════════════════════════════════════════════════════╗\n`;
    text += `║  Architecture Health Index: ${report.ahi.toFixed(1)}/10 — ${report.level}  ${icon}\n`;
    text += `║  Mode: ${modeLabel}\n`;
    text += `║  Files analyzed: ${report.filesAnalyzed} (${report.coreFiles.length} core)\n`;
    text += `╚══════════════════════════════════════════════════════════╝\n\n`;

    text += `### Signal Breakdown\n\n`;
    for (const c of report.components) {
        const cIcon = c.score >= 0.7 ? "✅" : (c.score >= 0.4 ? "⚠️" : "🔴");
        const displayScore = c.available ? `${(c.score * 10).toFixed(0)}/10` : "N/A";
        const weightStr = c.weight > 0 ? ` (${(c.weight * 100).toFixed(0)}%)` : " (inactive)";
        text += `${cIcon} **${c.name}**: ${displayScore}${weightStr} — ${c.detail}\n`;
    }

    if (report.issues.length > 0) {
        text += `\n### Top Issues (ordered by blast radius)\n\n`;
        const display = report.issues.slice(0, 7);
        for (let i = 0; i < display.length; i++) {
            const issue = display[i];
            const sIcon = issue.severity === "critical" ? "🔴" : (issue.severity === "high" ? "🟠" : "🟡");
            text += `${i + 1}. ${sIcon} **${issue.file}** — ${issue.type}\n`;
            text += `   ${issue.detail}\n`;
            text += `   → ${issue.action}\n\n`;
        }
        if (report.issues.length > 7) {
            text += `   ... and ${report.issues.length - 7} more issues.\n\n`;
        }
    }

    if (report.issues.length > 0) {
        text += `### Recovery Plan\n\n`;
        text += report.recoveryPlan;
    }

    text += `\n---\n`;
    text += `*This is a deterministic score calculated from your dependency graph, type system, and test coverage. It is not an opinion.*\n`;
    text += `*Run \`nreki_guard action:"audit"\` again after making changes to see your score improve.*`;

    return text;
}
