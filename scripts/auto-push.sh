#!/bin/bash
# Auto-push script: pushes current branch to origin after each commit
# Retry with exponential backoff on network failure

BRANCH=$(git rev-parse --abbrev-ref HEAD)
MAX_RETRIES=4
DELAY=2

for i in $(seq 1 $MAX_RETRIES); do
  if git push -u origin "$BRANCH" 2>&1; then
    echo "[auto-push] Successfully pushed to origin/$BRANCH"
    exit 0
  fi
  echo "[auto-push] Push failed (attempt $i/$MAX_RETRIES). Retrying in ${DELAY}s..."
  sleep $DELAY
  DELAY=$((DELAY * 2))
done

echo "[auto-push] Failed to push after $MAX_RETRIES attempts."
exit 1
