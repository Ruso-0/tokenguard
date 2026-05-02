const { spawn } = require('child_process');
const proc = spawn('node', ['bin/nreki.cjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
proc.stdout.on('data', d => out += d.toString());
proc.stderr.on('data', d => {});

const init = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'audit', version: '1.0' }
    }
}) + '\n';

const list = JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/list'
}) + '\n';

proc.stdin.write(init);
setTimeout(() => proc.stdin.write(list), 500);

setTimeout(() => {
    const lines = out.split('\n').filter(l => l.includes('"id":2'));
    if (lines.length > 0) {
        try {
            const parsed = JSON.parse(lines[0]);
            const tools = parsed.result?.tools || [];
            console.log('Tools encontrados: ' + tools.length);
            let allClean = true;
            for (const t of tools) {
                const hasExec = t.execution !== undefined;
                console.log('  - ' + t.name + ' tiene execution? ' + hasExec);
                if (hasExec) allClean = false;
            }
            console.log(allClean ? '[PASS] Schema limpio' : '[FAIL] execution sigue presente');
        } catch (e) {
            console.log('Parse failed: ' + e.message);
            console.log('Raw line: ' + lines[0]);
        }
    } else {
        console.log('[FAIL] no se recibió respuesta a tools/list');
        console.log('Raw output: ' + out.substring(0, 500));
    }
    proc.kill();
    process.exit(0);
}, 3000);
