# Claud-MALsystem

## Project Overview
MAL (MyAnimeList) system powered by Claude Code. This project is designed for remote development from Claude Code Web (browser) and iOS environments.

## Development Environment

### Remote Access
- **Browser**: Claude Code Web (claude.ai/code)
- **iOS**: Claude iOS App → Claude Code
- Both environments connect to the same remote container

### Branch Strategy
- `main`: Stable branch
- Feature branches: `claude/*` prefix for Claude Code sessions

## Commands

### Build & Test
```bash
# Run all tests
./scripts/test.sh

# Lint check
./scripts/lint.sh

# Health check (verify environment is ready)
./scripts/health-check.sh
```

## Project Structure
```
.
├── CLAUDE.md              # This file - Claude Code instructions
├── README.md              # Project overview
├── .claude/
│   └── settings.json      # Claude Code settings & hooks
├── scripts/
│   ├── health-check.sh    # Environment health check
│   ├── test.sh            # Test runner
│   ├── lint.sh            # Lint runner
│   └── auto-push.sh       # Auto-push after task completion
└── src/                   # Source code (to be developed)
```

## Conventions
- Commit messages: Japanese or English, concise description of changes
- Auto-push is enabled via PostToolUse hook — every successful commit is automatically pushed
- All scripts must be executable (`chmod +x`)

## Notes for Remote Sessions
- The session start hook runs `health-check.sh` to verify the environment
- Git is pre-configured with the remote origin
- Always work on the designated feature branch

---

## リモート開発ルール (Desktop / Web / iOS共通)

### 基本原則
1. **作業開始時**: 必ず `git pull origin master` で最新コードを取得
2. **作業完了時**: 必ず `git add . && git commit && git push origin master` で変更をプッシュ
3. **コンフリクト防止**: 同一ファイルをデスクトップとリモートで同時編集しない

### 環境別の制約

| 操作 | Desktop | Web/iOS |
|------|---------|---------|
| コード編集 | OK | OK |
| git push/pull | OK | OK |
| wrangler deploy | OK | **NG** (CLIなし) |
| D1マイグレーション | OK | **NG** |
| npm install | OK | 要確認 |

### ブランチ戦略
- **master**: 本番デプロイ用。安定コードのみ。
- **remote/\***: リモート版での作業用ブランチ (例: `remote/feature-xxx`)
- リモート版での大きな変更は `remote/` ブランチで作業し、デスクトップ版でmasterにマージ＆デプロイ

### デプロイフロー
```
[リモート版] コード変更 → git push (remote/ブランチ)
    ↓
[デスクトップ版] git pull → レビュー → masterにマージ → wrangler deploy
```

### 禁止事項
- リモート版から `wrangler.toml` のリソースIDを変更しない
- `.env` や認証情報をコミットしない
- `node_modules/` をコミットしない
- masterブランチへの force push 禁止
