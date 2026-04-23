#!/usr/bin/env node
import fs from "fs";
import path from "path";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => stdin += chunk);
process.stdin.on("end", () => {
    try {
        const payload = JSON.parse(stdin);
        const tool = payload.tool_name || payload.name || "";
        const input = payload.tool_input || payload.input || {};
        const targetPath = input.file_path || input.path || input.file || input.target_file || input.absolute_path;
        if (!targetPath) process.exit(0);
        let absPath;
        let size = 0;
        try {
            absPath = path.resolve(process.cwd(), targetPath).replace(/\\/g, "/");
            const cwdPosix = process.cwd().replace(/\\/g, "/");
            if (!absPath.startsWith(cwdPosix + "/") && absPath !== cwdPosix) {
                console.error("Blocked: Path traversal attempt.");
                process.exit(2);
            }
            size = fs.statSync(absPath).size;
        } catch {
            process.exit(0);
        }
        if (size < 1024) process.exit(0);
        if (size > 500000) {
            if (/^(Write|Edit|Replace)(File)?$/i.test(tool)) {
                console.error("Blocked: Native writes forbidden on >100L files. Use nreki_code edit or batch_edit.");
                process.exit(2);
            }
            if (/^(Read|View)(File)?$/i.test(tool) || tool === "read_file") {
                console.error("Blocked: >100L file. Use nreki_navigate outline then nreki_code compress focus.");
                process.exit(2);
            }
            process.exit(0);
        }
        const buf = fs.readFileSync(absPath);
        let lines = 1;
        for (let i = 0; i < buf.length; i++) {
            if (buf[i] === 10) lines++;
            if (lines >= 100) break;
        }
        if (lines < 100) process.exit(0);
        if (/^(Write|Edit|Replace)(File)?$/i.test(tool)) {
            console.error("Blocked: Native writes forbidden on >100L files. Use nreki_code edit or batch_edit.");
            process.exit(2);
        }
        if (/^(Read|View)(File)?$/i.test(tool) || tool === "read_file") {
            console.error("Blocked: >100L file. Use nreki_navigate outline then nreki_code compress focus.");
            process.exit(2);
        }
        process.exit(0);
    } catch (e) {
        process.exit(0);
    }
});
