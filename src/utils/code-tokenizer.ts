/**
 * code-tokenizer.ts — Code-aware identifier tokenizer for TokenGuard.
 *
 * Splits code identifiers (camelCase, PascalCase, snake_case, SCREAMING_CASE,
 * dot-separated) into sub-tokens for better keyword search matching.
 */

/**
 * Split a code identifier into its constituent sub-tokens.
 *
 * Handles:
 * - camelCase: "authMiddleware" → ["auth", "middleware"]
 * - PascalCase: "AuthMiddleware" → ["auth", "middleware"]
 * - snake_case: "auth_middleware" → ["auth", "middleware"]
 * - SCREAMING_CASE: "MAX_RETRY_COUNT" → ["max", "retry", "count"]
 * - dot notation: "req.body.user" → ["req", "body", "user"]
 * - Mixed: "getAPIResponse" → ["get", "api", "response"]
 * - Includes original (lowercased, joined) for exact match
 *
 * @param identifier - The code identifier to tokenize
 * @returns Array of sub-tokens plus the original joined form
 */
export function codeTokenize(identifier: string): string[] {
    if (!identifier || identifier.length === 0) return [];

    // Split on dots first: "req.body.user" → ["req", "body", "user"]
    const dotParts = identifier.split(".");
    const subTokens: string[] = [];

    for (const part of dotParts) {
        if (part.length === 0) continue;

        // Split on underscores: "auth_middleware" → ["auth", "middleware"]
        const underscoreParts = part.split("_").filter(p => p.length > 0);

        for (const uPart of underscoreParts) {
            // Split camelCase/PascalCase
            const camelTokens = splitCamelCase(uPart);
            for (const t of camelTokens) {
                const lower = t.toLowerCase();
                if (lower.length > 0) {
                    subTokens.push(lower);
                }
            }
        }
    }

    // Deduplicate sub-tokens
    const unique = [...new Set(subTokens)];

    // Add the original identifier (lowercased, no separators) for exact match
    const original = identifier.replace(/[._]/g, "").toLowerCase();
    if (original.length > 0 && !unique.includes(original)) {
        unique.push(original);
    }

    return unique;
}

/**
 * Split a camelCase or PascalCase string into parts.
 *
 * "getAPIResponse" → ["get", "API", "Response"]
 * "HTMLParser" → ["HTML", "Parser"]
 * "onClick" → ["on", "Click"]
 */
function splitCamelCase(str: string): string[] {
    if (str.length === 0) return [];

    // Use regex-based approach for reliable acronym handling
    // Split on transitions: lowercase→uppercase, uppercase→uppercase+lowercase
    const parts = str.replace(
        /([a-z0-9])([A-Z])/g, "$1\x00$2"  // camelCase boundary
    ).replace(
        /([A-Z]+)([A-Z][a-z])/g, "$1\x00$2"  // ACRONYMWord boundary
    ).split("\x00");

    return parts.filter(p => p.length > 0);
}
