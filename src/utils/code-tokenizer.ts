/**
 * code-tokenizer.ts — Code-aware identifier tokenizer for TokenGuard.
 *
 * Splits code identifiers (camelCase, PascalCase, snake_case, SCREAMING_CASE,
 * dot-separated, $-prefixed, _-prefixed) into sub-tokens for keyword search.
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
 * - $prefix: "$scope" → ["scope"]
 * - __dunder__: "__proto__" → ["proto"]
 * - _private: "_privateVar" → ["private", "var"]
 *
 * @param identifier - The code identifier to tokenize
 * @returns Array of lowercased sub-tokens
 */
export function codeTokenize(identifier: string): string[] {
    if (!identifier || identifier.length === 0) return [];

    // Split on dots first: "req.body.user" → ["req", "body", "user"]
    const dotParts = identifier.split(".");
    const subTokens: string[] = [];

    for (const part of dotParts) {
        if (part.length === 0) continue;

        // Strip $ and _ prefixes/suffixes, replace with space
        const clean = part.replace(/[$_]+/g, " ").trim();
        if (clean.length === 0) continue;

        // Match: ACRONYMS, PascalWords, camelWords, numbers
        const matches = clean.match(
            /[A-Z]{2,}(?=[A-Z][a-z]|\d|\b)|[A-Z]?[a-z]+|[A-Z]+|\d+/g
        );

        if (matches) {
            for (const m of matches) {
                const lower = m.toLowerCase();
                if (lower.length > 0) {
                    subTokens.push(lower);
                }
            }
        }
    }

    // Deduplicate sub-tokens
    const unique = [...new Set(subTokens)];

    return unique;
}
