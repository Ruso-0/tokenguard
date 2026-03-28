/**
 * shadow-generator.ts -Tree-sitter based TypeScript file classifier and .d.ts shadow generator.
 *
 * Classifies TypeScript files as PRUNABLE (all exports have explicit type annotations)
 * or UNPRUNABLE (any export relies on type inference). For prunable files, generates
 * lightweight .d.ts shadow content that preserves structural type information.
 *
 * Uses Tree-sitter for accurate AST walking, not regex.
 */

import Parser from "web-tree-sitter";
import { ParserPool } from "../parser-pool.js";
import fs from "fs";
import path from "path";
import { toPosix } from "../utils/to-posix.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ClassifyResult {
    prunable: boolean;
    shadow: string | null;
    reasons: string[];
    category: "explicit" | "inferred" | "no-exports";
}

export interface ScanStats {
    total: number;
    pruned: number;
    unpruned: number;
    noExports: number;
}

export interface ScanResult {
    prunable: Map<string, string>;   // posixPath -> shadow .d.ts content
    unprunable: Set<string>;
    ambientFiles: string[];
    stats: ScanStats;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
    "node_modules", "dist", "build", ".git", ".next", "coverage",
]);

function isSimpleLiteral(node: Parser.SyntaxNode): boolean {
    const t = node.type;
    // String literal (no template expressions)
    if (t === "string") return true;
    // Number literal
    if (t === "number") return true;
    // Boolean
    if (t === "true" || t === "false") return true;
    // null
    if (t === "null") return true;
    // undefined
    if (t === "undefined") return true;
    // Negative number: unary_expression with "-" and number
    if (t === "unary_expression") {
        const op = node.child(0);
        const operand = node.child(1);
        if (op?.text === "-" && operand?.type === "number") return true;
    }
    return false;
}

function literalTypeString(node: Parser.SyntaxNode, isConst: boolean): string {
    const t = node.type;
    const text = node.text;

    if (t === "string") {
        return isConst ? text : "string";
    }
    if (t === "number") {
        return isConst ? text : "number";
    }
    if (t === "true" || t === "false") {
        return isConst ? text : "boolean";
    }
    if (t === "null") return "null";
    if (t === "undefined") return "undefined";
    if (t === "unary_expression") {
        // Negative number
        return isConst ? text : "number";
    }
    return "any";
}

/**
 * Extract text from startIndex to endIndex of a node, but strip
 * the body block (everything from first '{' at depth 0).
 * Used for functions and methods.
 */
function extractSignature(content: string, node: Parser.SyntaxNode): string {
    const bodyNode = node.childForFieldName("body");
    if (!bodyNode) {
        // No body (e.g., overload signature) - return as-is
        return content.substring(node.startIndex, node.endIndex);
    }
    // Return everything up to the body
    return content.substring(node.startIndex, bodyNode.startIndex).trimEnd();
}

/**
 * Get the text range of a node, preserving original formatting.
 */
function nodeText(content: string, node: Parser.SyntaxNode): string {
    return content.substring(node.startIndex, node.endIndex);
}

// ─── Classification ──────────────────────────────────────────────────

interface ExportClassification {
    prunable: boolean;
    reason: string;
}

function classifyExportedFunction(
    funcNode: Parser.SyntaxNode,
): ExportClassification {
    // Function overload signatures (no body) are always prunable
    const body = funcNode.childForFieldName("body");
    if (!body) {
        return { prunable: true, reason: "function overload signature" };
    }

    const returnType = funcNode.childForFieldName("return_type");
    if (returnType) {
        return { prunable: true, reason: "function with explicit return type" };
    }
    return { prunable: false, reason: "function without return type" };
}

function classifyExportedVariable(
    declarator: Parser.SyntaxNode,
    kind: string,
): ExportClassification {
    const typeAnnotation = declarator.childForFieldName("type");
    if (typeAnnotation) {
        return { prunable: true, reason: `${kind} with type annotation` };
    }

    const value = declarator.childForFieldName("value");
    if (!value) {
        return { prunable: false, reason: `${kind} without type annotation or value` };
    }

    // Check for simple literal values
    if (isSimpleLiteral(value)) {
        return { prunable: true, reason: `${kind} with primitive literal` };
    }

    // Everything else is unprunable
    const vt = value.type;
    if (vt === "object") return { prunable: false, reason: `${kind} = object literal` };
    if (vt === "array") return { prunable: false, reason: `${kind} = array literal` };
    if (vt === "new_expression") return { prunable: false, reason: `${kind} = new expression` };
    if (vt === "call_expression") return { prunable: false, reason: `${kind} = function call` };
    if (vt === "arrow_function") {
        // Arrow without return type on the const itself
        return { prunable: false, reason: `${kind} = arrow function without type annotation` };
    }
    if (vt === "function_expression" || vt === "function") {
        return { prunable: false, reason: `${kind} = function expression without type annotation` };
    }
    if (vt === "template_string") {
        // Template literals with expressions are unprunable
        const hasExpr = value.children.some(c => c.type === "template_substitution");
        if (hasExpr) return { prunable: false, reason: `${kind} = template literal with expressions` };
        // Plain template string (no expressions) - treat as string literal
        return { prunable: true, reason: `${kind} with template literal (no expressions)` };
    }

    return { prunable: false, reason: `${kind} = complex expression (${vt})` };
}

/**
 * Classify a single top-level node (export_statement or ambient declaration).
 * Returns null if the node is not an export (skip it).
 */
function classifyNode(node: Parser.SyntaxNode): ExportClassification | null {
    // ─── Re-exports ──────────────────────────────────────────
    if (node.type === "export_statement") {
        const source = node.childForFieldName("source");
        // export * from "..." or export { ... } from "..."
        if (source) {
            return { prunable: true, reason: "re-export" };
        }

        // export { localA, localB } (no "from")
        const hasDeclaration = node.childForFieldName("declaration");
        if (!hasDeclaration) {
            // Check if it's export { ... } (named re-export from local scope)
            const hasExportClause = node.children.some(c => c.type === "export_clause");
            if (hasExportClause) {
                return { prunable: true, reason: "local re-export" };
            }
            // export default <expression>
            const defaultKw = node.children.some(c => c.type === "default");
            if (defaultKw) {
                // Check if it's export default class or export default function
                const valueNode = node.children.find(c =>
                    c.type !== "export" && c.type !== "default" &&
                    c.type !== "comment" && c.type !== ";",
                );
                if (valueNode) {
                    if (valueNode.type === "class_declaration" || valueNode.type === "class") {
                        return { prunable: true, reason: "export default class" };
                    }
                    if (valueNode.type === "function_declaration" || valueNode.type === "function") {
                        return classifyExportedFunction(valueNode);
                    }
                }
                return { prunable: false, reason: "export default expression" };
            }
            return null; // Not a classifiable export
        }

        const decl = hasDeclaration;

        // ─── Interface ───────────────────────────────────────
        if (decl.type === "interface_declaration") {
            return { prunable: true, reason: "interface" };
        }

        // ─── Type alias ──────────────────────────────────────
        if (decl.type === "type_alias_declaration") {
            return { prunable: true, reason: "type alias" };
        }

        // ─── Enum ────────────────────────────────────────────
        if (decl.type === "enum_declaration") {
            return { prunable: true, reason: "enum" };
        }

        // ─── Class (abstract or regular) ─────────────────────
        if (decl.type === "class_declaration" || decl.type === "abstract_class_declaration") {
            return { prunable: true, reason: "class" };
        }

        // ─── Function ────────────────────────────────────────
        if (decl.type === "function_declaration") {
            return classifyExportedFunction(decl);
        }

        // ─── Function overloads (multiple signatures) ────────
        if (decl.type === "function_signature") {
            return { prunable: true, reason: "function overload signature" };
        }

        // ─── Lexical declaration (const/let/var) ─────────────
        if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
            const kindNode = decl.child(0);
            const kind = kindNode?.text ?? "const";

            for (const child of decl.children) {
                if (child.type === "variable_declarator") {
                    const result = classifyExportedVariable(child, kind);
                    if (!result.prunable) return result;
                }
            }
            return { prunable: true, reason: `${kind} (all declarators explicit)` };
        }

        // ─── Ambient declarations ────────────────────────────
        if (decl.type === "ambient_declaration") {
            return { prunable: true, reason: "ambient declaration" };
        }

        // Unknown declaration type - conservative: unprunable
        return { prunable: false, reason: `unknown export declaration: ${decl.type}` };
    }

    // ─── Ambient declarations at top level ───────────────────
    if (node.type === "ambient_declaration") {
        return { prunable: true, reason: "ambient declaration" };
    }

    return null; // Not an export, skip
}

// ─── Shadow Generation ───────────────────────────────────────────────

/**
 * Check if a function_declaration at root child index `idx` is the implementation
 * signature of an overload group. True if any earlier sibling is an exported
 * function_declaration or function_signature with the same name and no body.
 */
function isOverloadImplementation(
    root: Parser.SyntaxNode,
    idx: number,
    funcName: string,
): boolean {
    for (let j = idx - 1; j >= 0; j--) {
        const prev = root.child(j)!;
        if (prev.type !== "export_statement") continue;
        const prevDecl = prev.childForFieldName("declaration");
        if (!prevDecl) continue;

        // Previous sibling is a function overload signature (no body, same name)
        if (prevDecl.type === "function_signature") {
            const prevName = prevDecl.childForFieldName("name")?.text;
            if (prevName === funcName) return true;
        }
        // Previous sibling is a function_declaration without body (also overload)
        if (prevDecl.type === "function_declaration") {
            const prevName = prevDecl.childForFieldName("name")?.text;
            if (prevName === funcName && !prevDecl.childForFieldName("body")) {
                return true;
            }
            // Different function name - stop looking
            if (prevName !== funcName) break;
        }
        // Non-function export - stop looking
        if (prevDecl.type !== "function_declaration" && prevDecl.type !== "function_signature") {
            break;
        }
    }
    return false;
}

/**
 * Generate .d.ts shadow content for a prunable file.
 * Walks the AST and emits declaration-only content.
 */
function generateShadow(
    content: string,
    tree: Parser.Tree,
): string {
    const lines: string[] = [];
    const root = tree.rootNode;

    for (let i = 0; i < root.childCount; i++) {
        const node = root.child(i)!;

        // ─── Import statements: keep them (needed for type resolution) ───
        if (node.type === "import_statement") {
            // Skip side-effect imports: import "foo" / import 'foo'
            const source = node.childForFieldName("source");
            const hasClause = node.children.some(c =>
                c.type === "import_clause" || c.type === "namespace_import" ||
                c.type === "named_imports",
            );
            if (hasClause || !source) {
                lines.push(nodeText(content, node));
            }
            continue;
        }

        // ─── Ambient declarations ────────────────────────────────────
        if (node.type === "ambient_declaration") {
            lines.push(nodeText(content, node));
            continue;
        }

        // ─── Export statements ───────────────────────────────────────
        if (node.type !== "export_statement") continue;

        const source = node.childForFieldName("source");

        // Re-exports: copy verbatim
        if (source) {
            lines.push(nodeText(content, node));
            continue;
        }

        const decl = node.childForFieldName("declaration");

        // export { ... } - copy verbatim
        if (!decl) {
            lines.push(nodeText(content, node));
            continue;
        }

        // ─── Interface / Type / Enum: copy verbatim ─────────────────
        if (
            decl.type === "interface_declaration" ||
            decl.type === "type_alias_declaration" ||
            decl.type === "enum_declaration"
        ) {
            lines.push(nodeText(content, node));
            continue;
        }

        // ─── Class: keep structure, strip method bodies ─────────────
        if (decl.type === "class_declaration" || decl.type === "abstract_class_declaration") {
            lines.push(emitClassShadow(content, node, decl));
            continue;
        }

        // ─── Function: emit signature only ──────────────────────────
        if (decl.type === "function_declaration") {
            // Overload exclusion: if this function has a body AND a previous
            // sibling is an overload signature with the same name, this is the
            // implementation signature - invisible in .d.ts, skip it.
            const funcBody = decl.childForFieldName("body");
            if (funcBody) {
                const funcName = decl.childForFieldName("name")?.text;
                if (funcName && isOverloadImplementation(root, i, funcName)) {
                    continue; // Skip implementation signature
                }
            }
            lines.push(emitFunctionShadow(content, node, decl));
            continue;
        }

        // ─── Function signature (overload without body) ─────────────
        if (decl.type === "function_signature") {
            lines.push(nodeText(content, node));
            continue;
        }

        // ─── Lexical declaration (const/let/var) ────────────────────
        if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
            lines.push(emitVariableShadow(content, decl));
            continue;
        }

        // ─── Ambient declaration ────────────────────────────────────
        if (decl.type === "ambient_declaration") {
            lines.push(nodeText(content, node));
            continue;
        }

        // Fallback: copy verbatim
        lines.push(nodeText(content, node));
    }

    return lines.join("\n") + "\n";
}

function emitClassShadow(
    content: string,
    exportNode: Parser.SyntaxNode,
    classNode: Parser.SyntaxNode,
): string {
    const bodyNode = classNode.childForFieldName("body");
    if (!bodyNode) {
        return nodeText(content, exportNode);
    }

    // Emit everything up to class body opening brace
    let result = content.substring(exportNode.startIndex, bodyNode.startIndex + 1) + "\n";

    // Walk class body members
    for (let j = 0; j < bodyNode.childCount; j++) {
        const member = bodyNode.child(j)!;

        // Skip { and } tokens
        if (member.type === "{" || member.type === "}") continue;

        // Method definitions and constructors: strip body, keep signature
        if (member.type === "method_definition") {
            const methodBody = member.childForFieldName("body");
            if (methodBody) {
                let sig = content.substring(member.startIndex, methodBody.startIndex).trimEnd();
                // Strip default parameter values from signatures (invalid in .d.ts)
                sig = stripParameterDefaults(sig);
                // Constructor parameter properties: strip access modifiers
                // (private/protected/public/readonly are invalid on params in .d.ts)
                const nameNode = member.childForFieldName("name");
                if (nameNode?.text === "constructor") {
                    sig = stripConstructorParamProperties(sig);
                }
                result += sig + ";\n";
            } else {
                result += nodeText(content, member) + "\n";
            }
            continue;
        }

        // Property declarations: strip initializers (TS1039 in ambient context)
        if (member.type === "public_field_definition" || member.type === "property_declaration") {
            result += emitPropertyDeclaration(content, member) + "\n";
            continue;
        }

        // Everything else (decorators, semicolons, etc.): copy verbatim
        result += nodeText(content, member) + "\n";
    }

    result += "}";
    return result;
}

/**
 * Strip default parameter values from a method/constructor signature.
 * e.g. "constructor(private x = 5, y: string = 'a')" -> "constructor(private x: any, y: string)"
 * This is needed because .d.ts files cannot have parameter initializers.
 */
function stripParameterDefaults(sig: string): string {
    // Find the parameter list between the outermost parens
    const openParen = sig.indexOf("(");
    if (openParen === -1) return sig;

    // Find matching close paren. Track () [] {} for depth -NOT <> because
    // arrow functions (=>) would be misread as closing angle brackets.
    // Also skip string literals to avoid depth corruption from chars inside strings.
    let depth = 0;
    let closeParen = -1;
    let inString: string | null = null;
    for (let i = openParen; i < sig.length; i++) {
        const ch = sig[i];
        if (inString) {
            if (ch === inString && sig[i - 1] !== "\\") inString = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        if (ch === ")" || ch === "]" || ch === "}") {
            depth--;
            if (depth === 0 && ch === ")") { closeParen = i; break; }
        }
    }
    if (closeParen === -1) return sig;

    const before = sig.substring(0, openParen + 1);
    const params = sig.substring(openParen + 1, closeParen);
    const after = sig.substring(closeParen);

    const cleanedParams = splitAndCleanParams(params);
    return before + cleanedParams + after;
}

function splitAndCleanParams(params: string): string {
    const result: string[] = [];
    let depth = 0;
    let current = "";
    let inString: string | null = null;

    for (let i = 0; i < params.length; i++) {
        const ch = params[i];
        if (inString) {
            if (ch === inString && params[i - 1] !== "\\") inString = null;
            current += ch;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inString = ch; current += ch; continue; }
        if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
        if (ch === ")" || ch === "]" || ch === "}") depth--;
        if (ch === ">" && !(i > 0 && params[i - 1] === "=") && depth > 0) depth--;
        if (ch === "," && depth === 0) {
            result.push(cleanSingleParam(current.trim()));
            current = "";
        } else {
            current += ch;
        }
    }
    if (current.trim()) result.push(cleanSingleParam(current.trim()));
    return result.join(", ");
}

function cleanSingleParam(param: string): string {
    if (!param) return param;

    // Find "=" at depth 0 (the default value).
    // Only track () [] {} - not <> (arrow => would corrupt depth).
    // AUDIT FIX: Track string state to skip "=" inside string literals.
    let depth = 0;
    let eqIdx = -1;
    let inString: string | null = null;
    for (let i = 0; i < param.length; i++) {
        const ch = param[i];
        if (inString) {
            if (ch === inString && param[i - 1] !== "\\") inString = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        if (ch === ")" || ch === "]" || ch === "}") depth--;
        if (ch === "=" && depth === 0 && param[i - 1] !== "!" && param[i + 1] !== ">") {
            eqIdx = i;
            break;
        }
    }

    if (eqIdx === -1) return param; // No default value

    const beforeEq = param.substring(0, eqIdx).trimEnd();

    // Check if there's already a type annotation before the =
    // e.g. "y: string = 'a'" -> "y: string" (just strip " = 'a'")
    // e.g. "private x = 5" -> "private x: any" (no type, add : any)
    if (hasTypeAnnotation(beforeEq)) {
        return beforeEq;
    }

    // No type annotation - need to add one. Use the default value to infer a simple type.
    const defaultVal = param.substring(eqIdx + 1).trim();
    const inferredType = inferSimpleType(defaultVal);
    return beforeEq + ": " + inferredType;
}

function hasTypeAnnotation(paramBefore: string): boolean {
    // Walk backward from end, skip whitespace, look for a type annotation pattern.
    // A type annotation has ":" followed by a type. But ":" can also appear in
    // destructuring. We check if there's a ":" that isn't inside brackets.
    let depth = 0;
    for (let i = paramBefore.length - 1; i >= 0; i--) {
        const ch = paramBefore[i];
        if (ch === ")" || ch === ">" || ch === "]" || ch === "}") depth++;
        if (ch === "(" || ch === "<" || ch === "[" || ch === "{") depth--;
        if (ch === ":" && depth === 0) return true;
    }
    return false;
}

/**
 * Strip parameter property modifiers from constructor parameters.
 * "constructor(private x: number, protected readonly y: string)"
 * -> "constructor(x: number, y: string)"
 * TS2369: parameter properties are only allowed in constructor implementations.
 */
function stripConstructorParamProperties(sig: string): string {
    const openParen = sig.indexOf("(");
    if (openParen === -1) return sig;

    let depth = 0;
    let closeParen = -1;
    for (let i = openParen; i < sig.length; i++) {
        const ch = sig[i];
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        if (ch === ")" || ch === "]" || ch === "}") {
            depth--;
            if (depth === 0 && ch === ")") { closeParen = i; break; }
        }
    }
    if (closeParen === -1) return sig;

    const before = sig.substring(0, openParen + 1);
    const params = sig.substring(openParen + 1, closeParen);
    const after = sig.substring(closeParen);

    // Process each param: strip leading access modifiers
    const ACCESS_MODIFIERS = /^(?:(?:private|protected|public|readonly|override)\s+)+/;
    const cleaned = splitParams(params).map(p => {
        const trimmed = p.trim();
        return trimmed.replace(ACCESS_MODIFIERS, "");
    });

    return before + cleaned.join(", ") + after;
}

/** Split parameter string respecting nested brackets AND string literals. */
function splitParams(params: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let current = "";
    // PATCH-7: Track string state to avoid splitting on commas inside quotes.
    // Without this, `constructor(public filter = "a,b")` produces broken .d.ts.
    let inString: string | null = null;
    for (let i = 0; i < params.length; i++) {
        const ch = params[i];
        if (inString) {
            if (ch === "\\" && i + 1 < params.length) {
                current += ch + params[i + 1];
                i++;
                continue;
            }
            if (ch === inString) inString = null;
            current += ch;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            inString = ch;
            current += ch;
            continue;
        }
        if (ch === "(" || ch === "<" || ch === "[" || ch === "{") depth++;
        if (ch === ")" || ch === "]" || ch === "}") depth--;
        if (ch === ">" && !(i > 0 && params[i - 1] === "=") && depth > 0) depth--;
        if (ch === "," && depth === 0) {
            result.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    if (current.trim()) result.push(current);
    return result;
}

function inferSimpleType(defaultVal: string): string {
    if (/^["']/.test(defaultVal)) return "string";
    if (/^-?\d/.test(defaultVal)) return "number";
    if (defaultVal === "true" || defaultVal === "false") return "boolean";
    if (defaultVal === "null") return "null";
    if (defaultVal === "undefined") return "undefined";
    return "unknown";
}

/**
 * Emit a class property declaration, stripping initializers.
 * "private cache = new Map()" -> "private cache: unknown;"
 * "public name: string = 'x'" -> "public name: string;"
 * "readonly x = 5" -> "readonly x: number;"
 */
function emitPropertyDeclaration(content: string, member: Parser.SyntaxNode): string {
    const valueNode = member.childForFieldName("value");
    if (!valueNode) {
        // No initializer - emit as-is (already declaration-only)
        const text = nodeText(content, member);
        return text.endsWith(";") ? text : text + ";";
    }

    // Has initializer - strip it
    // Get everything before the "=" sign
    const beforeValue = content.substring(member.startIndex, valueNode.startIndex);
    // Find the "=" and strip it
    const eqIdx = beforeValue.lastIndexOf("=");
    if (eqIdx === -1) {
        const text = nodeText(content, member);
        return text.endsWith(";") ? text : text + ";";
    }

    let declaration = beforeValue.substring(0, eqIdx).trimEnd();

    // Check if there's a type annotation
    if (!hasTypeAnnotation(declaration)) {
        // Infer type from the value
        const valText = nodeText(content, valueNode).trim();
        const inferredType = inferSimpleType(valText);
        declaration += ": " + inferredType;
    }

    return declaration + ";";
}

function emitFunctionShadow(
    content: string,
    exportNode: Parser.SyntaxNode,
    funcNode: Parser.SyntaxNode,
): string {
    const body = funcNode.childForFieldName("body");
    if (!body) {
        // No body (overload signature) - copy as-is
        return nodeText(content, exportNode);
    }

    // Extract signature (everything before the body)
    const beforeExport = content.substring(exportNode.startIndex, funcNode.startIndex);
    const sig = extractSignature(content, funcNode);

    // Check for "default" keyword
    const isDefault = beforeExport.includes("default");
    // In .d.ts files, "declare" is implicit - "export default declare function" is invalid syntax
    const exportPrefix = isDefault ? "export default " : "export declare ";

    // Strip the "export" / "export default" prefix from the signature and re-add with "declare"
    let cleanSig = sig.trimEnd();
    // Strip parameter defaults (invalid in .d.ts ambient context)
    cleanSig = stripParameterDefaults(cleanSig);

    return exportPrefix + cleanSig + ";";
}

function emitVariableShadow(
    content: string,
    declNode: Parser.SyntaxNode,
): string {
    const kindNode = declNode.child(0);
    const kind = kindNode?.text ?? "const";
    const isConst = kind === "const";
    const emitKw = isConst ? "const" : "let";

    const parts: string[] = [];

    for (const child of declNode.children) {
        if (child.type !== "variable_declarator") continue;

        const nameNode = child.childForFieldName("name");
        const typeNode = child.childForFieldName("type");
        const valueNode = child.childForFieldName("value");
        const name = nameNode?.text ?? "unknown";

        if (typeNode) {
            // Has type annotation: emit without value
            const typeText = nodeText(content, typeNode);
            parts.push(`${name}${typeText}`);
        } else if (valueNode && isSimpleLiteral(valueNode)) {
            // Primitive literal
            const litType = literalTypeString(valueNode, isConst);
            parts.push(`${name}: ${litType}`);
        } else {
            // Fallback for complex expressions - use any
            parts.push(`${name}: any`);
        }
    }

    // Keyword goes ONCE here, not inside the loop
    return `export declare ${emitKw} ${parts.join(", ")};`;
}

// ─── Main Classification + Generation ────────────────────────────────

export function classifyAndGenerateShadow(
    _filePath: string,
    content: string,
    parser: Parser,
    language: Parser.Language,
): ClassifyResult {
    parser.setLanguage(language);
    const tree = parser.parse(content);

    try {
        const root = tree.rootNode;
        const reasons: string[] = [];
        let hasExports = false;
        let allPrunable = true;

        for (let i = 0; i < root.childCount; i++) {
            const node = root.child(i)!;
            const classification = classifyNode(node);
            if (classification === null) continue;

            hasExports = true;
            reasons.push(
                `${classification.prunable ? "PRUNABLE" : "UNPRUNABLE"}: ${classification.reason}`,
            );

            if (!classification.prunable) {
                allPrunable = false;
            }
        }

        if (!hasExports) {
            return { prunable: false, shadow: null, reasons: ["no exports"], category: "no-exports" };
        }

        if (!allPrunable) {
            return { prunable: false, shadow: null, reasons, category: "inferred" };
        }

        // Generate shadow .d.ts
        const shadow = generateShadow(content, tree);
        return { prunable: true, shadow, reasons, category: "explicit" };
    } finally {
        tree.delete(); // CRITICAL: prevent WASM memory leak
    }
}

// ─── Project Scanner ─────────────────────────────────────────────────

function walkDirectory(dir: string): string[] {
    const files: string[] = [];
    const stack = [dir];

    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
                    stack.push(path.join(current, entry.name));
                }
            } else if (
                /\.(ts|tsx)$/i.test(entry.name) &&
                !entry.name.endsWith(".d.ts")
            ) {
                files.push(toPosix(path.join(current, entry.name)));
            }
        }
    }

    return files;
}

export async function scanProject(
    rootDir: string,
    parserPool: ParserPool,
): Promise<ScanResult> {
    // Ensure WASM runtime is initialized before loading languages
    await parserPool.initialize();

    // Load TypeScript language
    const wasmDir = path.join(
        path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1")),
        "..", "..", "wasm",
    );
    const tsWasmPath = path.join(wasmDir, "tree-sitter-typescript.wasm");
    const tsLanguage = await Parser.Language.load(toPosix(tsWasmPath));

    const files = walkDirectory(rootDir);
    const prunable = new Map<string, string>();
    const unprunable = new Set<string>();
    const ambientFiles: string[] = [];
    let noExports = 0;

    // Process files with parser pool for concurrency
    const BATCH_SIZE = 50;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (filePath) => {
            let content: string;
            try {
                content = fs.readFileSync(path.normalize(filePath), "utf-8");
            } catch {
                return;
            }

            // Ambient file detection
            if (
                content.includes("declare global") ||
                content.includes("declare module") ||
                content.includes("/// <reference")
            ) {
                ambientFiles.push(filePath);
            }

            const parser = await parserPool.acquire(tsLanguage, "typescript");
            try {
                const result = classifyAndGenerateShadow(filePath, content, parser, tsLanguage);
                if (result.category === "no-exports") {
                    noExports++;
                } else if (result.prunable && result.shadow) {
                    prunable.set(filePath, result.shadow);
                } else {
                    unprunable.add(filePath);
                }
            } finally {
                parserPool.release("typescript", parser);
            }
        }));
    }

    // Add @types declaration files as ambient.
    // Walk up from rootDir to find node_modules/@types (handles monorepos
    // where tsconfig is in src/ but node_modules is at repo root).
    const typeRoots: string[] = [];
    let searchDir = rootDir;
    for (let depth = 0; depth < 5; depth++) {
        const candidate = path.join(searchDir, "node_modules", "@types");
        if (fs.existsSync(candidate)) {
            typeRoots.push(candidate);
            break;
        }
        const parent = path.dirname(searchDir);
        if (parent === searchDir) break; // filesystem root
        searchDir = parent;
    }
    for (const root of typeRoots) {
        try {
            for (const pkg of fs.readdirSync(root)) {
                const indexDts = toPosix(path.join(root, pkg, "index.d.ts"));
                if (fs.existsSync(path.normalize(indexDts))) {
                    ambientFiles.push(indexDts);
                }
            }
        } catch { /* non-fatal */ }
    }

    return {
        prunable,
        unprunable,
        ambientFiles,
        stats: {
            total: files.length,
            pruned: prunable.size,
            unpruned: unprunable.size,
            noExports,
        },
    };
}
