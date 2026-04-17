#!/usr/bin/env bash
# Git自動プッシュフック（PostToolUse用）
# CLAUDE.mdで定義したリモート開発ルールに従い、コミット後に自動pushする

set -e

# git pushはmasterまたは現在のブランチへ
BRANCH=$(git branch --show-current 2>/dev/null)

if [ -z "$BRANCH" ]; then
  echo "Not on any branch — skipping push"
  exit 0
fi

# masterブランチへの自動pushを許可
if git push origin "$BRANCH" 2>&1; then
  echo "✅ Pushed to origin/$BRANCH"
else
  echo "⚠️  Push failed (may need manual intervention)"
fi
