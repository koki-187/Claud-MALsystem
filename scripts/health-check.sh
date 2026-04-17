#!/usr/bin/env bash
# MAL検索システム 環境ヘルスチェック
# Usage: ./scripts/health-check.sh

set -e

echo "🔍 MAL検索システム ヘルスチェック開始"
echo "================================================"

ok() { echo "  ✅ $1"; }
ng() { echo "  ❌ $1"; FAIL=1; }
warn() { echo "  ⚠️  $1"; }

FAIL=0

# 1. Git
echo ""
echo "[1/5] Git環境"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  ok "Git リポジトリ: $(git remote get-url origin 2>/dev/null || echo 'no remote')"
  ok "現在ブランチ: $(git branch --show-current)"
  if [ -z "$(git status --porcelain)" ]; then
    ok "作業ツリー: クリーン"
  else
    warn "未コミット変更あり: $(git status --porcelain | wc -l) ファイル"
  fi
else
  ng "Gitリポジトリではありません"
fi

# 2. Node / npm
echo ""
echo "[2/5] Node環境"
command -v node >/dev/null 2>&1 && ok "node: $(node --version)" || ng "node 未インストール"
command -v npm  >/dev/null 2>&1 && ok "npm:  $(npm --version)"  || ng "npm 未インストール"

# 3. wrangler (Desktop only)
echo ""
echo "[3/5] Cloudflare wrangler"
if command -v wrangler >/dev/null 2>&1; then
  ok "wrangler: $(wrangler --version 2>&1 | head -1)"
else
  warn "wrangler 未インストール（リモート環境ならOK）"
fi

# 4. gh CLI
echo ""
echo "[4/5] GitHub CLI"
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    ok "gh: 認証済み ($(gh api user --jq .login 2>/dev/null))"
  else
    warn "gh は使えるが未認証"
  fi
else
  warn "gh CLI 未インストール（必須ではない）"
fi

# 5. プロジェクトファイル
echo ""
echo "[5/5] プロジェクト構成"
[ -f "wrangler.toml" ]   && ok "wrangler.toml" || ng "wrangler.toml なし"
[ -f "package.json" ]    && ok "package.json"  || ng "package.json なし"
[ -f "CLAUDE.md" ]       && ok "CLAUDE.md"     || warn "CLAUDE.md なし"
[ -d "src" ]             && ok "src/"          || ng "src/ なし"
[ -d "migrations" ]      && ok "migrations/"   || ng "migrations/ なし"

echo ""
echo "================================================"
if [ "$FAIL" = "1" ]; then
  echo "❌ ヘルスチェック失敗 — 上記の問題を解決してください"
  exit 1
else
  echo "✅ ヘルスチェック完了"
fi
