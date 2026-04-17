/**
 * hooks/cognitive-enforcer.ts — Capa 2 del Escudo Cognitivo.
 * State machine en RAM. Falla en 1ms. Cero I/O pesado.
 * Sincroniza pasaportes a disco para resiliencia en reinicios MCP.
 */

import fs from "fs";
import path from "path";

interface FilePassport {
    outlined: boolean;
    rawRead: boolean;
    focusedSymbols: Set<string>;
}

interface EnforcerState {
    files: Record<string, { outlined: boolean; rawRead: boolean; focusedSymbols: string[] }>;
}

export class CognitiveEnforcer {
    private passports = new Map<string, FilePassport>();
    private projectRoot: string;
    private stateFile: string;

    constructor(projectRoot: string) {
        this.projectRoot = projectRoot;
        this.stateFile = path.join(projectRoot, ".nreki", "enforcer-state.json");
        this.loadState();
    }

    private loadState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const data = JSON.parse(fs.readFileSync(this.stateFile, "utf-8"), (k, v) => {
                    if (k === "__proto__" || k === "constructor" || k === "prototype") return undefined;
                    return v;
                }) as EnforcerState;
                if (data.files) {
                    for (const [filePath, p] of Object.entries(data.files)) {
                        this.passports.set(filePath, {
                            outlined: !!p.outlined,
                            rawRead: !!p.rawRead,
                            focusedSymbols: new Set(p.focusedSymbols || [])
                        });
                    }
                }
            }
        } catch {}
    }

    private saveState() {
        try {
            const dir = path.dirname(this.stateFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const data: EnforcerState = { files: {} };
            for (const [filePath, p] of this.passports.entries()) {
                if (p.outlined || p.rawRead || p.focusedSymbols.size > 0) {
                    data.files[filePath] = {
                        outlined: p.outlined,
                        rawRead: p.rawRead,
                        focusedSymbols: Array.from(p.focusedSymbols)
                    };
                }
            }
            const tmpFile = `${this.stateFile}.tmp`;
            fs.writeFileSync(tmpFile, JSON.stringify(data), "utf-8");
            fs.renameSync(tmpFile, this.stateFile);
        } catch {}
    }

    private getPassport(filePath: string): FilePassport {
        if (!this.passports.has(filePath)) {
            this.passports.set(filePath, { outlined: false, rawRead: false, focusedSymbols: new Set() });
        }
        return this.passports.get(filePath)!;
    }

    private countLines(filePath: string): number {
        try {
            const buf = fs.readFileSync(filePath);
            let lines = 1;
            for (let i = 0; i < buf.length; i++) {
                if (buf[i] === 10) lines++;
                if (lines >= 100) return lines;
            }
            return lines;
        } catch { return 0; }
    }


    private validateSingleBatchEdit(edit: any): { blocked: boolean; errorText?: string } {
        // Patch mode has its own anti-ambiguity (occurrences === 1). Safe to pass through.
        if (edit.mode === "patch") return { blocked: false };

        if (edit.mode === "insert_before" || edit.mode === "insert_after") {
            if (!edit.path) return { blocked: false };
            try {
                const insertSize = fs.statSync(path.resolve(this.projectRoot, edit.path)).size;
                if (insertSize < 50000) return { blocked: false };
            } catch { return { blocked: false }; }
            const ip = path.resolve(this.projectRoot, edit.path).replace(/\\/g, "/");
            const ipass = this.getPassport(ip);
            if (!ipass.outlined && !ipass.rawRead) {
                return {
                    blocked: true,
                    errorText: `Blocked: Blind insert on large file (${edit.path}). Run outline or compress focus:"..." first.`,
                };
            }
            return { blocked: false };
        }

        if (edit.symbol && edit.path) {
            try {
                const p = path.resolve(this.projectRoot, edit.path).replace(/\\/g, "/");
                const pass = this.getPassport(p);
                if (!pass.focusedSymbols.has(edit.symbol) && !pass.rawRead) {
                    return {
                        blocked: true,
                        errorText: `Blocked: Blind batch_edit on "${edit.symbol}" in ${edit.path}. Run compress focus:"${edit.symbol}" first.`,
                    };
                }
            } catch { /* stat/path errors fall through as permissive */ }
        }
        return { blocked: false };
    }

    public evaluate(tool: string, action: string, params: any): { blocked: boolean; errorText?: string; penalty?: number } {
        if (tool !== "nreki_code") return { blocked: false };
        if (!["read", "compress", "edit", "batch_edit"].includes(action)) return { blocked: false };

        // LEY 3.5: Anti-Contrabando. Valida TODO edit del batch, no solo length===1.
        // Fix round-5: antes, un batch de 2+ eludía el cortafuegos (1 real blind + 1 dummy).
        if (action === "batch_edit" && params.edits) {
            for (const edit of params.edits) {
                const result = this.validateSingleBatchEdit(edit);
                if (result.blocked) return result;
            }
            return { blocked: false };
        }

        if (!params.path) return { blocked: false };

        let absPath: string;
        let size = 0;
        try {
            absPath = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
            size = fs.statSync(absPath).size;
        } catch { return { blocked: false }; }

        // LEY 0: Fast bypass
        if (size < 1024) return { blocked: false };

        // OOM Guard: >500KB — NEVER readFileSync, assume >100 lines
        const lines = size <= 500000 ? this.countLines(absPath) : Infinity;
        if (lines < 100) return { blocked: false };

        const passport = this.getPassport(absPath);

        // Escape hatch: SOLO para read/compress. Cobra peaje. Nunca para edit.
        const isEscapeHatch = params._nreki_bypass === "chronos_recovery" && (action === "read" || action === "compress");
        if (isEscapeHatch) {
            return { blocked: false, penalty: 0.3 };
        }

        // LEY 1: Raw read BLOQUEADO SIEMPRE. Sin excepciones post-outline.
        if (action === "read") {
            return { blocked: true, errorText: `Blocked: >100L file. Raw read destroys context. Use compress focus:"<symbol>".` };
        }

        // LEY 2: Compress sin focus BLOQUEADO. Sin excepción de level:"light".
        if (action === "compress") {
            if (!params.focus) {
                if (!passport.outlined && !passport.rawRead) {
                    return { blocked: true, errorText: `Blocked: >100L file. Run outline first.` };
                } else {
                    return { blocked: true, errorText: `Blocked: Monolithic compress forbidden. Use focus:"<symbol>".` };
                }
            }
            return { blocked: false };
        }

        // LEY 3: Edit a ciegas BLOQUEADO. Visa Dorada (rawRead) da inmunidad.
        if (action === "edit" && params.symbol) {
            if (params.mode === "patch") {
                return { blocked: false };
            }
            if (params.mode === "insert_before" || params.mode === "insert_after") {
                if (size < 50000) return { blocked: false };
                if (!passport.outlined && !passport.rawRead) {
                    return { blocked: true, errorText: `Blocked: Blind insert on large file. Run outline or compress focus:"${params.symbol}" first.` };
                }
                return { blocked: false };
            }
            if (!passport.focusedSymbols.has(params.symbol) && !passport.rawRead) {
                return { blocked: true, errorText: `Blocked: Blind edit. Run compress focus:"${params.symbol}" first.` };
            }
        }

        return { blocked: false };
    }

    // LEY 5: Amnesia Quirúrgica
    public registerSuccess(tool: string, action: string, params: any) {
        let changed = false;
        try {
            if (tool === "nreki_navigate" && action === "outline" && params.path) {
                const p = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
                this.getPassport(p).outlined = true;
                changed = true;
            } else if (tool === "nreki_code") {
                if ((action === "read" || action === "compress") && params._nreki_bypass === "chronos_recovery" && params.path) {
                    const p = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
                    this.getPassport(p).rawRead = true;
                    changed = true;
                } else if (action === "compress" && params.focus && params.path) {
                    const p = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
                    this.getPassport(p).focusedSymbols.add(params.focus);
                    this.getPassport(p).outlined = true;
                    changed = true;
                } else if (action === "edit" && params.symbol && params.path) {
                    const p = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
                    this.getPassport(p).focusedSymbols.delete(params.symbol);
                    this.getPassport(p).rawRead = false;
                    changed = true;
                } else if (action === "batch_edit" && params.edits) {
                    for (const edit of params.edits) {
                        if (edit.path && edit.symbol) {
                            const p = path.resolve(this.projectRoot, edit.path).replace(/\\/g, "/");
                            this.getPassport(p).focusedSymbols.delete(edit.symbol);
                            this.getPassport(p).rawRead = false;
                            changed = true;
                        }
                    }
                }
            }
        } catch {}
        if (changed) this.saveState();
    }
}
