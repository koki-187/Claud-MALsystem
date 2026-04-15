#!/bin/bash
# Lint runner placeholder
# Add project-specific linting here as the project grows

echo "=== Running Lint Check ==="

ISSUES=0

# Check shell scripts for basic issues
for script in scripts/*.sh; do
  if [ -f "$script" ]; then
    if head -1 "$script" | grep -q '^#!/bin/bash'; then
      echo "[OK] $script: has shebang"
    else
      echo "[WARN] $script: missing shebang"
      ISSUES=$((ISSUES + 1))
    fi
  fi
done

# Check for trailing whitespace in key files
for file in CLAUDE.md README.md; do
  if [ -f "$file" ]; then
    TRAILING=$(grep -n ' $' "$file" | wc -l)
    if [ "$TRAILING" -gt 0 ]; then
      echo "[WARN] $file: $TRAILING lines with trailing whitespace"
      ISSUES=$((ISSUES + 1))
    else
      echo "[OK] $file: no trailing whitespace"
    fi
  fi
done

echo ""
if [ $ISSUES -eq 0 ]; then
  echo "=== Lint check passed ==="
else
  echo "=== $ISSUES issue(s) found ==="
fi
