#!/usr/bin/env tsx
/**
 * diag-pyright-lsp.ts
 * 
 * Diagnostic script to capture pyright 1.1.409 LSP codeAction responses
 * for "reportUndefinedVariable" errors.
 * 
 * Usage: npx tsx scripts/diag-pyright-lsp.ts
 * 
 * Purpose: Determine whether pyright exposes auto-import quickfix
 * via standard LSP textDocument/codeAction protocol.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TEST_FILE = 'C:\\tmp\\pyright-test\\test.py';
const TEST_URI = `file:///${TEST_FILE.replace(/\\/g, '/')}`;
const TIMEOUT_MS = 15_000;

// â”€â”€ LSP Message Framing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let msgId = 0;
function nextId(): number { return ++msgId; }

function encodeLspMessage(msg: object): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

// â”€â”€ LSP Response Parser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
class LspParser {
  private buffer = '';
  private handlers = new Map<number, (result: any) => void>();
  private notificationHandlers = new Map<string, (params: any) => void>();

  feed(data: string): void {
    this.buffer += data;
    this.tryParse();
  }

  private tryParse(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) return; // need more data

      const body = this.buffer.slice(bodyStart, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);

      try {
        const msg = JSON.parse(body);
        this.dispatch(msg);
      } catch (e) {
        console.error('[PARSE ERROR]', e);
      }
    }
  }

  private dispatch(msg: any): void {
    if ('id' in msg && 'result' in msg) {
      // Response
      const handler = this.handlers.get(msg.id);
      if (handler) {
        this.handlers.delete(msg.id);
        handler(msg.result);
      }
    } else if ('id' in msg && 'error' in msg) {
      // Error response
      const handler = this.handlers.get(msg.id);
      if (handler) {
        this.handlers.delete(msg.id);
        handler({ __lspError: msg.error });
      }
    } else if ('method' in msg && !('id' in msg)) {
      // Notification
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) handler(msg.params);
    }
    // Also log server requests (method + id but no result)
    if ('method' in msg && 'id' in msg && !('result' in msg)) {
      console.log(`\n[SERVER REQUEST] ${msg.method} (id=${msg.id})`);
      console.log(JSON.stringify(msg.params, null, 2));
    }
  }

  onResponse(id: number): Promise<any> {
    return new Promise(resolve => {
      this.handlers.set(id, resolve);
    });
  }

  onNotification(method: string, handler: (params: any) => void): void {
    this.notificationHandlers.set(method, handler);
  }
}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
  console.log('  Pyright LSP codeAction Diagnostic');
  console.log('  pyright-langserver --stdio');
  console.log(`  Test file: ${TEST_FILE}`);
  console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');

  // Verify test file exists
  if (!fs.existsSync(TEST_FILE)) {
    console.error(`ERROR: Test file not found: ${TEST_FILE}`);
    process.exit(1);
  }

  const testContent = fs.readFileSync(TEST_FILE, 'utf-8');
  console.log('[TEST FILE CONTENT]');
  console.log(testContent);
  console.log('');

  // Global timeout
  const timer = setTimeout(() => {
    console.error('\n[TIMEOUT] 15s elapsed â€” pyright did not respond in time.');
    proc.kill('SIGTERM');
    process.exit(2);
  }, TIMEOUT_MS);

  // Spawn pyright-langserver
  const proc: ChildProcess = spawn('basedpyright-langserver', ['--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  proc.stderr?.on('data', (data: Buffer) => {
    console.error(`[PYRIGHT STDERR] ${data.toString().trim()}`);
  });

  proc.on('error', (err) => {
    console.error('[SPAWN ERROR]', err);
    clearTimeout(timer);
    process.exit(1);
  });

  proc.on('exit', (code) => {
    console.log(`\n[PYRIGHT EXITED] code=${code}`);
    clearTimeout(timer);
  });

  const parser = new LspParser();
  proc.stdout?.on('data', (data: Buffer) => {
    parser.feed(data.toString());
  });

  function send(msg: object): void {
    const encoded = encodeLspMessage(msg);
    proc.stdin?.write(encoded);
  }

  function sendRequest(method: string, params: any): Promise<any> {
    const id = nextId();
    send({ jsonrpc: '2.0', id, method, params });
    return parser.onResponse(id);
  }

  function sendNotification(method: string, params: any): void {
    send({ jsonrpc: '2.0', method, params });
  }

  // â”€â”€ Step 1: Initialize â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('[STEP 1] Sending initialize...');
  const initResult = await sendRequest('initialize', {
    processId: process.pid,
    capabilities: {
      textDocument: {
        codeAction: {
          codeActionLiteralSupport: {
            codeActionKind: {
              valueSet: [
                'quickfix',
                'refactor',
                'refactor.extract',
                'refactor.inline',
                'refactor.rewrite',
                'source',
                'source.organizeImports',
                'source.fixAll',
              ],
            },
          },
          resolveSupport: {
            properties: ['edit'],
          },
        },
        publishDiagnostics: {
          relatedInformation: true,
          tagSupport: { valueSet: [1, 2] },
          versionSupport: true,
        },
        completion: {
          completionItem: {
            snippetSupport: true,
            resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
          },
        },
      },
      workspace: {
        applyEdit: true,
        workspaceEdit: {
          documentChanges: true,
        },
        executeCommand: {
          dynamicRegistration: true,
        },
      },
    },
    rootUri: `file:///C:/tmp/pyright-test`,
    workspaceFolders: [
      { uri: `file:///C:/tmp/pyright-test`, name: 'pyright-test' },
    ],
  });

  console.log('\n[INITIALIZE RESULT] Server capabilities (codeAction-related):');
  const caps = initResult?.capabilities || {};
  console.log(JSON.stringify({
    codeActionProvider: caps.codeActionProvider,
    executeCommandProvider: caps.executeCommandProvider,
  }, null, 2));

  // Send initialized notification
  sendNotification('initialized', {});
  console.log('[STEP 1] initialized notification sent.\n');

  // â”€â”€ Step 2: Open test file â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('[STEP 2] Opening test file via textDocument/didOpen...');
  sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: TEST_URI,
      languageId: 'python',
      version: 1,
      text: testContent,
    },
  });

  // â”€â”€ Step 3: Wait for diagnostics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('[STEP 3] Waiting for textDocument/publishDiagnostics...\n');

  const diagnostics: any[] = await new Promise((resolve) => {
    parser.onNotification('textDocument/publishDiagnostics', (params) => {
      console.log('[DIAGNOSTICS RECEIVED]');
      console.log(`  URI: ${params.uri}`);
      console.log(`  Count: ${params.diagnostics?.length || 0}`);
      console.log('');

      if (params.diagnostics && params.diagnostics.length > 0) {
        for (const d of params.diagnostics) {
          console.log(`  [${d.severity === 1 ? 'ERROR' : d.severity === 2 ? 'WARN' : 'INFO'}] L${d.range.start.line}:${d.range.start.character}-L${d.range.end.line}:${d.range.end.character}`);
          console.log(`    message: ${d.message}`);
          console.log(`    code: ${d.code}`);
          console.log(`    source: ${d.source}`);
          if (d.data) console.log(`    data: ${JSON.stringify(d.data)}`);
          console.log('');
        }
        resolve(params.diagnostics);
      }
    });
  });

  // â”€â”€ Step 4: Request codeActions for each error diagnostic â”€â”€â”€â”€â”€â”€â”€
  const errorDiags = diagnostics.filter((d: any) => d.severity === 1);
  console.log(`\n[STEP 4] Requesting codeActions for ${errorDiags.length} error diagnostics...\n`);

  for (let i = 0; i < errorDiags.length; i++) {
    const diag = errorDiags[i];
    console.log(`â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”`);
    console.log(`[CODEACTION REQUEST ${i + 1}/${errorDiags.length}]`);
    console.log(`  Diagnostic: "${diag.message}" (code: ${diag.code})`);
    console.log(`  Range: L${diag.range.start.line}:${diag.range.start.character}-L${diag.range.end.line}:${diag.range.end.character}`);

    const codeActionResult = await sendRequest('textDocument/codeAction', {
      textDocument: { uri: TEST_URI },
      range: diag.range,
      context: {
        diagnostics: [diag],
        only: ['quickfix'],
        triggerKind: 1, // Invoked
      },
    });

    console.log(`\n  [CODEACTION RESPONSE]:`);
    if (codeActionResult?.__lspError) {
      console.log(`  ERROR: ${JSON.stringify(codeActionResult.__lspError, null, 2)}`);
    } else if (!codeActionResult || codeActionResult.length === 0) {
      console.log(`  âš  EMPTY â€” No code actions returned.`);
    } else {
      console.log(`  âœ“ ${codeActionResult.length} code action(s) returned:`);
      for (const action of codeActionResult) {
        console.log(`\n    â”€â”€â”€ Action â”€â”€â”€`);
        console.log(`    title: "${action.title}"`);
        console.log(`    kind:  ${action.kind}`);
        if (action.command) {
          console.log(`    command: ${JSON.stringify(action.command, null, 6)}`);
        }
        if (action.edit) {
          console.log(`    edit: ${JSON.stringify(action.edit, null, 6)}`);
        }
        if (action.data) {
          console.log(`    data: ${JSON.stringify(action.data, null, 6)}`);
        }
        if (action.isPreferred) {
          console.log(`    isPreferred: true`);
        }
        // Full verbatim dump
        console.log(`    [FULL JSON]:`);
        console.log(JSON.stringify(action, null, 4));
      }
    }
    console.log('');
  }

  // â”€â”€ Step 5: Also try executeCommand for pyright.addMissingImport â”€
  console.log('â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”');
  console.log('[STEP 5] Checking executeCommandProvider commands...');
  if (caps.executeCommandProvider?.commands) {
    console.log('  Available commands:');
    for (const cmd of caps.executeCommandProvider.commands) {
      console.log(`    - ${cmd}`);
    }
  } else {
    console.log('  No executeCommandProvider advertised.');
  }

  // â”€â”€ Step 6: Try codeAction without "only" filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (errorDiags.length > 0) {
    console.log('\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”');
    console.log('[STEP 6] Re-requesting codeActions WITHOUT "only" filter for first error...');
    const diag = errorDiags[0];
    const unfilteredResult = await sendRequest('textDocument/codeAction', {
      textDocument: { uri: TEST_URI },
      range: diag.range,
      context: {
        diagnostics: [diag],
        triggerKind: 1,
      },
    });

    console.log(`\n  [UNFILTERED CODEACTION RESPONSE]:`);
    if (unfilteredResult?.__lspError) {
      console.log(`  ERROR: ${JSON.stringify(unfilteredResult.__lspError, null, 2)}`);
    } else if (!unfilteredResult || unfilteredResult.length === 0) {
      console.log(`  âš  EMPTY â€” No code actions returned (even without filter).`);
    } else {
      console.log(`  âœ“ ${unfilteredResult.length} code action(s) returned:`);
      for (const action of unfilteredResult) {
        console.log(`    - [${action.kind}] "${action.title}"`);
        console.log(`      ${JSON.stringify(action, null, 6)}`);
      }
    }
  }

  // â”€â”€ Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('\nâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
  console.log('[DONE] Shutting down pyright-langserver...');
  
  await sendRequest('shutdown', null);
  sendNotification('exit', null);

  // Give pyright a moment to exit
  await new Promise(r => setTimeout(r, 1000));
  
  clearTimeout(timer);
  proc.kill();
  
  console.log('[COMPLETE] Diagnostic finished.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
