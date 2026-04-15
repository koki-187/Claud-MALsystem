# Claud-MALsystem

Claude Code によるリモート開発環境プロジェクト。

## 特徴

- **ブラウザ対応**: Claude Code Web (claude.ai/code) からリモート開発可能
- **iOS対応**: Claude iOS アプリから Claude Code にアクセスして開発可能
- **自動プッシュ**: コミット完了時に自動で GitHub にプッシュ
- **環境ヘルスチェック**: セッション開始時に自動で環境を検証

## セットアップ

このリポジトリを Claude Code のリモート環境で開くだけで利用可能です。

1. Claude Code Web または iOS アプリで新しいセッションを開始
2. このリポジトリを選択
3. セッション開始時にヘルスチェックが自動実行される

## スクリプト

| コマンド | 説明 |
|---------|------|
| `./scripts/health-check.sh` | 環境の健全性チェック |
| `./scripts/test.sh` | テスト実行 |
| `./scripts/lint.sh` | リントチェック |
| `./scripts/auto-push.sh` | 自動プッシュ（フックから呼び出し） |

## 仕組み

### 自動プッシュ
`.claude/settings.json` の `PostToolUse` フックにより、`git commit` 実行後に自動で `git push` が実行されます。ネットワークエラー時はエクスポネンシャルバックオフで最大4回リトライします。

### セッション開始フック
`SessionStart` フックにより、セッション開始時に `health-check.sh` が実行され、環境の準備状態を確認します。