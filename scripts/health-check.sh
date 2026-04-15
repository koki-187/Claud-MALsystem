#!/bin/bash
# Health check: verify the remote development environment is ready

echo "=== Claud-MALsystem Environment Health Check ==="
echo ""

ERRORS=0

# Check git
if command -v git &> /dev/null; then
  echo "[OK] git: $(git --version)"
else
  echo "[NG] git: not found"
  ERRORS=$((ERRORS + 1))
fi

# Check current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ $? -eq 0 ]; then
  echo "[OK] branch: $BRANCH"
else
  echo "[NG] branch: not in a git repository"
  ERRORS=$((ERRORS + 1))
fi

# Check remote
REMOTE=$(git remote get-url origin 2>/dev/null)
if [ $? -eq 0 ]; then
  echo "[OK] remote: $REMOTE"
else
  echo "[NG] remote: origin not configured"
  ERRORS=$((ERRORS + 1))
fi

# Check working directory
echo "[OK] working directory: $(pwd)"

# Check scripts are executable
for script in auto-push.sh health-check.sh test.sh lint.sh; do
  if [ -x "scripts/$script" ]; then
    echo "[OK] scripts/$script: executable"
  elif [ -f "scripts/$script" ]; then
    echo "[WARN] scripts/$script: not executable, fixing..."
    chmod +x "scripts/$script"
  fi
done

echo ""
if [ $ERRORS -eq 0 ]; then
  echo "=== Environment is ready for remote development ==="
else
  echo "=== $ERRORS issue(s) found ==="
fi

exit $ERRORS
