import { ASTParser } from './src/parser.js';
import { readFileSync } from 'fs';

const parser = new ASTParser();
await parser.initialize();
const content = readFileSync('src/engine.ts', 'utf-8');
const result = await parser.parse('src/engine.ts', content);
console.log('Total chunks:', result.chunks.length);
for (const c of result.chunks) {
  const name = c.symbolName || c.shorthand.slice(0, 80);
  console.log(' ', c.nodeType, '|', name);
}
