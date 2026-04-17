export interface Defect {
    id: string;
    severity: 'high' | 'med' | 'low';
    label: string;
}

/**
 * NREKI DEFECT RADAR
 *
 * Parasitic inline detectors that run during `outline` on each symbol's raw
 * body. They surface LLM-rush signals (empty catches, any escapes, ts-suppress
 * comments, non-null assertions) as a tag in the outline header the LLM is
 * already reading. Zero new tool calls, zero new tokens — the signal lives
 * inside an existing surface.
 *
 * LIMITACIONES CONOCIDAS (v10.7.0):
 * 1. Template Interpolations: El regex de vaciado borra todo dentro de backticks (`).
 *    Defectos ocultos dentro de interpolaciones (${...}) son invisibles.
 * 2. Generic <any>: Match heurístico anclado a `<` o `,` posicionales para
 *    evitar falsos positivos en props JSX (<Comp anyProp={1}>).
 * 3. Function-boundary only: El radar opera sobre sym.body. Defectos que
 *    cruzan múltiples símbolos (ej. setInterval sin clearInterval en otro
 *    símbolo) son invisibles por diseño.
 */

interface InlineDetector {
    readonly id: string;
    readonly severity: 'high' | 'med' | 'low';
    readonly label: string;
    readonly match?: (cleanCode: string) => boolean;
    readonly matchRaw?: (rawCode: string) => boolean;
}

export const INLINE_DETECTORS: readonly InlineDetector[] = [
    {
        id: 'swallowed-error',
        severity: 'high',
        label: 'empty catch',
        match: (cleanCode) => /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(cleanCode)
    },
    {
        id: 'type-escape-any',
        severity: 'med',
        label: 'any escape',
        match: (cleanCode) => /\bas\s+any\b|:\s*any\b|<\s*any\b|,\s*any\b/.test(cleanCode)
    },
    {
        id: 'ts-suppress',
        severity: 'high',
        label: '@ts-suppress',
        matchRaw: (rawCode) => /@ts-(?:ignore|expect-error|nocheck)/.test(rawCode)
    },
    {
        id: 'non-null-assert',
        severity: 'low',
        label: 'non-null !',
        match: (cleanCode) => /\w+![.\[]/.test(cleanCode)
    }
];

export function stripForRadar(rawCode: string): string {
    return rawCode
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, '""');
}

export function runDefectRadar(rawCode: string): Defect[] {
    if (/\/\/\s*nreki-hunt:\s*disable/.test(rawCode)) return [];
    const cleanCode = stripForRadar(rawCode);
    const defects: Defect[] = [];
    for (const detector of INLINE_DETECTORS) {
        if (detector.match && detector.match(cleanCode)) {
            defects.push({ id: detector.id, severity: detector.severity, label: detector.label });
        } else if (detector.matchRaw && detector.matchRaw(rawCode)) {
            defects.push({ id: detector.id, severity: detector.severity, label: detector.label });
        }
    }
    const weights = { high: 0, med: 1, low: 2 } as const;
    return defects.sort((a, b) => weights[a.severity] - weights[b.severity]);
}
