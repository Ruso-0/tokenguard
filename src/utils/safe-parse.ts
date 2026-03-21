/**
 * safe-parse.ts - WASM-safe Tree-sitter parsing with automatic memory cleanup.
 *
 * Ensures tree.delete() is always called after parsing, preventing
 * WASM memory leaks from Tree-sitter trees that are not freed.
 */

import type Parser from "web-tree-sitter";

type Tree = Parser.Tree;

/**
 * Parse source code and execute a callback with the resulting tree,
 * guaranteeing cleanup via tree.delete() in a finally block.
 *
 * @param parser - Initialized Tree-sitter parser with language set
 * @param source - Source code string to parse
 * @param callback - Function that receives the parsed tree and returns a result
 * @returns The result of the callback
 */
export function safeParse<T>(
    parser: Parser,
    source: string,
    callback: (tree: Tree) => T
): T {
    const tree = parser.parse(source);
    let result: T;
    try {
        result = callback(tree);
    } catch (err) {
        tree.delete();
        throw err;
    }

    // If callback returned a Promise, defer tree.delete() until it settles
    if (result instanceof Promise) {
        return result.finally(() => tree.delete()) as unknown as T;
    }

    tree.delete();
    return result;
}
