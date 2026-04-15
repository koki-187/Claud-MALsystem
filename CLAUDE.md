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
