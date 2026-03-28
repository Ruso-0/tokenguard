#!/bin/bash
REPO_URL="${1:?Usage: ./run-miner.sh <repo-url>}"
REPO_NAME=$(basename "$REPO_URL" .git)
echo "=================================================="
echo "  NREKI CHRONOS ORCHESTRATOR - CRASH-ONLY MODE"
echo "  Target: $REPO_NAME"
echo "=================================================="
while true; do 
    WT_PATH="/tmp/nreki-wt-${REPO_NAME}"
    rm -rf "$WT_PATH"
    cd "/tmp/nreki-bare-${REPO_NAME}" 2>/dev/null && git worktree prune 2>/dev/null
    
    cd ~/Nreki 
    node --max-old-space-size=4096 ./node_modules/.bin/tsx scripts/chronos-miner.ts "$REPO_URL"
    
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 42 ]; then
        echo "=================================================="
        echo "  MINING 100% COMPLETE. Dataset ready."
        echo "=================================================="
        break
    elif [ $EXIT_CODE -eq 0 ]; then
        echo "[ORCHESTRATOR] Tactical Suicide. OS reclaimed WASM RAM. Resuming in 2s..."
        sleep 2
    else
        echo "[ORCHESTRATOR] Crash (exit $EXIT_CODE). Hard resume in 5s..."
        sleep 5
    fi
done
