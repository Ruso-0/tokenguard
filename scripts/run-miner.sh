#!/bin/bash
export NODE_OPTIONS="--max-old-space-size=49152"
REPO_URL="$1"
if [ -z "$REPO_URL" ]; then echo "Usage: ./run-miner.sh <repo-url>"; exit 1; fi
REPO_NAME=$(basename "$REPO_URL" .git)
RUN=1
echo "NREKI Chronos Miner v11.2 — Lanczos-PRO | Heap: 48GB"
while true; do
    echo "RUN #$RUN — $(date '+%Y-%m-%d %H:%M:%S')"
    npx tsx scripts/chronos-miner.ts "$REPO_URL"
    EXIT_CODE=$?
    echo "[ORCHESTRATOR] Exit code: $EXIT_CODE"
    if [ $EXIT_CODE -eq 42 ]; then echo "MINING COMPLETE — $REPO_NAME"; break
    elif [ $EXIT_CODE -eq 0 ]; then echo "Batch limit. Continuing..."; RUN=$((RUN + 1)); sleep 2
    else echo "Unexpected $EXIT_CODE. Retrying..."; RUN=$((RUN + 1)); sleep 5; fi
done
