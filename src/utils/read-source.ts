/**
 * read-source.ts — BOM-safe source file reader for TokenGuard.
 *
 * Windows editors often prepend an invisible BOM character (U+FEFF)
 * to UTF-8 files. Tree-sitter counts this as a byte offset, causing
 * AST-based edits to splice at the wrong position and corrupt files.
 *
 * All source file reads for AST parsing MUST use readSource() instead
 * of raw fs.readFileSync to strip the BOM transparently.
 */

import fs from "fs";

/**
 * Read a source file as UTF-8, stripping any leading BOM character.
 * Use this for all files that will be parsed by tree-sitter or used
 * for AST-based operations. Keep fs.readFileSync for JSON, configs,
 * and binary files.
 */
export function readSource(filePath: string): string {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}
