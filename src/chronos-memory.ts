import fs from "fs";
import path from "path";
import { NrekiKernel } from "./kernel/nreki-kernel.js";
import crypto from "crypto";

export interface TypeDebtRecord {
    symbol: string;
    strictType: string;
    degradedType: string;
    sessionIntroduced: number;
}

export interface FileFragility {
    trips: number;
    semanticErrors: number;
    autoHeals: number;
    cfiScore: number;
    lastErrorPattern: string | null;
    lastSessionTouched: number;
    unpaidTypeDebts?: TypeDebtRecord[];
}

export interface ChronosState {
    version: 1;
    currentSessionId: number;
    globalTechDebt: number;
    files: Record<string, FileFragility>;
}

export class ChronosMemory {
    private state: ChronosState;
    private dbPath: string;
    private projectRoot: string;
    private persistTimer: NodeJS.Timeout | null = null;
    private uncompressedReads = new Set<string>();

    // CFI Weights & Decay Configuration
    private readonly SESSION_DECAY = 0.85;
    private readonly SUCCESS_DISCOUNT = 0.50;
    private readonly W_TRIP = 10.0;
    private readonly W_ERROR = 3.0;
    private readonly W_HEAL = 1.0;
    public readonly CFI_ALERT_THRESHOLD = 15.0;

    constructor(projectRoot: string) {
        this.projectRoot = projectRoot;
        this.dbPath = path.join(projectRoot, ".nreki", "chronos-history.json");
        this.state = this.load();
        this.startSession();
    }

    private load(): ChronosState {
        if (fs.existsSync(this.dbPath)) {
            try { return JSON.parse(fs.readFileSync(this.dbPath, "utf-8")); } catch { /* Corrupt, start fresh */ }
        }
        return { version: 1, currentSessionId: 0, globalTechDebt: 0, files: {} };
    }

    // Debounced persistence (atomic write, crash-safe)
    private schedulePersist(): void {
        if (this.persistTimer) return;
        this.persistTimer = setTimeout(() => { this.forcePersist(); }, 1500);
    }

    public forcePersist(): void {
        if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const tmp = `${this.dbPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
        fs.renameSync(tmp, this.dbPath);
    }

    private startSession(): void {
        this.state.currentSessionId++;

        for (const file of Object.keys(this.state.files)) {
            // CLEANUP: Remove deleted files from state
            const absPath = path.resolve(this.projectRoot, file);
            if (!fs.existsSync(absPath)) {
                delete this.state.files[file];
                continue;
            }

            const data = this.state.files[file];
            const sessionsPassed = this.state.currentSessionId - data.lastSessionTouched;

            // A-11: Remove phantom entries (cfiScore 0, no debts) created by getFile
            if (data.cfiScore === 0 && !data.unpaidTypeDebts?.length) {
                delete this.state.files[file];
                continue;
            }

            if (sessionsPassed > 0) {
                data.cfiScore *= Math.pow(this.SESSION_DECAY, sessionsPassed);
                data.lastSessionTouched = this.state.currentSessionId;
                if (data.cfiScore < 1.0) delete this.state.files[file];
            }
        }
        this.forcePersist();
    }

    private normalize(filePath: string): string {
        return path.relative(this.projectRoot, path.resolve(this.projectRoot, filePath)).replace(/\\/g, "/");
    }

    private getFile(filePath: string): FileFragility {
        const norm = this.normalize(filePath);
        if (!this.state.files[norm]) {
            this.state.files[norm] = { trips: 0, semanticErrors: 0, autoHeals: 0, cfiScore: 0, lastErrorPattern: null, lastSessionTouched: this.state.currentSessionId };
        }
        this.state.files[norm].lastSessionTouched = this.state.currentSessionId;
        return this.state.files[norm];
    }

    // Read tracking for edit gating
    public markReadUncompressed(filePath: string): void {
        this.uncompressedReads.add(this.normalize(filePath));
    }

    public hasReadUncompressed(filePath: string): boolean {
        return this.uncompressedReads.has(this.normalize(filePath));
    }

    public isHighFriction(filePath: string): boolean {
        return (this.state.files[this.normalize(filePath)]?.cfiScore ?? 0) >= this.CFI_ALERT_THRESHOLD;
    }

    // Error tracking
    public recordTrip(filePath: string, errorPattern: string): void {
        const f = this.getFile(filePath);
        f.trips++; f.cfiScore += this.W_TRIP;
        f.lastErrorPattern = errorPattern.split('\n')[0].substring(0, 150);
        this.schedulePersist();
    }

    public recordSemanticError(filePath: string, firstError: string): void {
        const f = this.getFile(filePath);
        f.semanticErrors++; f.cfiScore += this.W_ERROR;
        f.lastErrorPattern = firstError.split('\n')[0].substring(0, 150);
        this.schedulePersist();
    }

    public recordHeal(filePath: string): void {
        const f = this.getFile(filePath);
        f.autoHeals++; f.cfiScore += this.W_HEAL;
        this.schedulePersist();
    }

    // SUCCESS REWARD: Successful edit on high-friction file halves CFI
    public recordSuccess(filePath: string): void {
        const norm = this.normalize(filePath);
        const f = this.state.files[norm];
        if (f && f.cfiScore > 0) {
            f.cfiScore *= this.SUCCESS_DISCOUNT;
            if (f.cfiScore < 1.0) delete this.state.files[norm];
            this.schedulePersist();
        }
    }

    /**
     * Record type regressions with submodular penalty.
     * Penalty grows logarithmically: 1 regression = 6 pts, 3 = 12, 15 = 24.
     * Stores the original strict type in a debt ledger for future restoration guidance.
     */
    public recordRegressions(filePath: string, regressions: Array<{ symbol: string; oldType: string; newType: string }>): void {
        if (!regressions || regressions.length === 0) return;
        const f = this.getFile(filePath);

        // Supermodular penalty: cost grows faster than linear.
        // 1 reg = 3.45 pts | 3 reg = 12.5 pts | 5 reg = 22.5 pts | 10 reg = 47.5 pts
        const penalty = this.W_ERROR * Math.pow(regressions.length, 1.2);
        f.cfiScore += penalty;

        // Debt ledger: store the original strict type so future agents
        // know exactly what to restore, instead of guessing.
        if (!f.unpaidTypeDebts) f.unpaidTypeDebts = [];
        for (const reg of regressions) {
            const existing = f.unpaidTypeDebts.find(d => d.symbol === reg.symbol);
            if (!existing) {
                f.unpaidTypeDebts.push({
                    symbol: reg.symbol,
                    strictType: reg.oldType.substring(0, 150),
                    degradedType: reg.newType.substring(0, 150),
                    sessionIntroduced: this.state.currentSessionId,
                });
            } else {
                // If degraded further, update current state but keep the original strict type
                existing.degradedType = reg.newType.substring(0, 150);
            }
        }

        // A-04: Cap debt ledger at 50 entries per file to prevent unbounded growth
        if (f.unpaidTypeDebts.length > 50) {
            f.unpaidTypeDebts.sort((a, b) => a.sessionIntroduced - b.sessionIntroduced);
            f.unpaidTypeDebts = f.unpaidTypeDebts.slice(-50);
        }

        f.lastErrorPattern = `[TYPE DEBT] ${regressions.length} symbol(s) weakened`;
        this.schedulePersist();
    }

    /**
     * Check if previously degraded types were restored or removed.
     * If the symbol's type is no longer toxic: debt paid, score reduced.
     * If the symbol was deleted entirely: debt cancelled (demolition is valid).
     * Returns list of symbols that were resolved.
     */
    public assessDebtPayments(filePath: string, currentContracts: Map<string, string> | undefined): string[] {
        const norm = this.normalize(filePath);
        const f = this.state.files[norm];
        if (!f || !f.unpaidTypeDebts || f.unpaidTypeDebts.length === 0) return [];

        const paidSymbols: string[] = [];

        f.unpaidTypeDebts = f.unpaidTypeDebts.filter(debt => {
            const currentType = currentContracts ? currentContracts.get(debt.symbol) : undefined;

            // If the symbol no longer exists in the file exports,
            // it was deleted. Deletion is a valid way to remove debt.
            if (!currentType) {
                paidSymbols.push(`${debt.symbol} (removed)`);
                return false;
            }

            // A-01: Use kernel's shared isToxicType to prevent divergence
            const isStillToxic = NrekiKernel.isToxicType(currentType);
            if (!isStillToxic) {
                paidSymbols.push(debt.symbol);
                return false;
            }

            return true; // Still toxic, debt remains
        });

        if (paidSymbols.length > 0) {
            // Each paid debt reduces the friction score
            f.cfiScore *= Math.pow(this.SUCCESS_DISCOUNT, paidSymbols.length);
            if (f.unpaidTypeDebts.length === 0) delete f.unpaidTypeDebts;
            this.schedulePersist();
        }

        return paidSymbols;
    }

    // Tech debt tracking
    public syncTechDebt(initialErrors: number, currentErrors: number): void {
        this.state.globalTechDebt += (currentErrors - initialErrors);
        this.forcePersist();
    }

    public getContextWarnings(filePath: string): string {
        const norm = this.normalize(filePath);
        const f = this.state.files[norm];
        if (!f || f.cfiScore < this.CFI_ALERT_THRESHOLD) return "";

        let warning = `\n\n**[NREKI CHRONOS]** High friction file detected.\n` +
               `File \`${norm}\` has a high error history (CFI Score: ${f.cfiScore.toFixed(1)}).\n` +
               `Past sessions: ${f.trips} circuit breaker trips, ${f.semanticErrors} cross-file type errors, ${f.autoHeals} auto-heals.\n` +
               `Last error: "${f.lastErrorPattern || 'Unknown'}".\n` +
               `**Required**: Read this file uncompressed before editing (\`nreki_code action:"read" compress:false\`). Use \`batch_edit\` if changing signatures.\n`;

        // Type debt details: tells the agent exactly what to restore
        if (f.unpaidTypeDebts && f.unpaidTypeDebts.length > 0) {
            warning += `\n**[UNPAID TYPE DEBT]**\n` +
                       `A previous AI agent weakened type contracts in this file. Restore strict typing:\n`;
            for (const d of f.unpaidTypeDebts.slice(-5)) {
                warning += `  - \`${d.symbol}\`: restore to \`${d.strictType}\` (currently \`${d.degradedType}\`)\n`;
            }
            warning += `Do not build on degraded contracts. Fix these first.\n`;
        }

        return warning;
    }

    public getHealthReport(initialErrors: number, currentErrors: number): string {
        const sessionDelta = currentErrors - initialErrors;
        const trend = sessionDelta < 0 ? "🟢 IMPROVING (Debt Paid)" : sessionDelta > 0 ? "🔴 DEGRADING (Debt Added)" : "⚪ STABLE";

        return [
            `+--------------------------------------------------+`,
            `|          NREKI CHRONOS HEALTH SCORE              |`,
            `+--------------------------------------------------+`,
            `|  Session ID:              ${String(this.state.currentSessionId).padStart(23)} |`,
            `|  Initial Boot Errors:     ${String(initialErrors).padStart(23)} |`,
            `|  Current Project Errors:  ${String(currentErrors).padStart(23)} |`,
            `|  Session Delta:           ${String((sessionDelta > 0 ? '+' : '') + sessionDelta).padStart(23)} |`,
            `|  Global Tech Debt:        ${String(this.state.globalTechDebt).padStart(23)} |`,
            `|  Project Trend:           ${String(trend).padStart(23)} |`,
            `+--------------------------------------------------+`
        ].join("\n");
    }
}
