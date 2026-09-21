#!/usr/bin/env bash
set -euo pipefail

# Bumps the pi-atomic-loop version in every place at once:
#   - package.json ("version")
#   - the install ref in README.md, DOCUMENTATION.md, DOCUMENTATION_ru.md
#     (pi install git:github.com/fbezruchko/pi-atomic-loop@vX.Y.Z)
#
# Then commits the touched files and tags vX.Y.Z. With --push it also
# pushes main + tag to origin.
#
# Usage: scripts/bump-version.sh <version> [--push]
#   e.g. scripts/bump-version.sh 1.0.8 --push

VER="${1:-}"
case "$VER" in
  v* | "" | -*)
    echo "usage: $0 <version, e.g. 1.0.8> [--push]" >&2
    exit 1
    ;;
esac

PUSH=0
[ "${2:-}" = "--push" ] && PUSH=1

cd "$(git rev-parse --show-toplevel)"

FILES=(README.md DOCUMENTATION.md DOCUMENTATION_ru.md)

echo "Bumping to v$VER:"
echo "  (remember to add a CHANGELOG.md entry for v$VER and stage it before running this script, if applicable)"

# 1) package.json version field (line edit, keeps file formatting).
sed -i.bak "s/\"version\": \".*\"/\"version\": \"$VER\"/" package.json
rm package.json.bak

# 2) install refs in the docs.
for f in "${FILES[@]}"; do
  sed -i.bak -E "s#(pi-atomic-loop@)v[0-9][0-9.]*#\1v$VER#g" "$f"
  rm "$f.bak"
done

# 3) Commit + tag.
git add package.json "${FILES[@]}"
git commit -m "Bump version to v$VER"

if git rev-parse -q --verify "refs/tags/v$VER" >/dev/null; then
  echo "tag v$VER already exists — refusing to overwrite." >&2
  exit 1
fi
git tag "v$VER"
echo "Committed and tagged v$VER."

if [ "$PUSH" = 1 ]; then
  git push origin main "v$VER"
  echo "Pushed main + v$VER. Install with: pi install git:github.com/fbezruchko/pi-atomic-loop@v$VER"
else
  echo "Run 'git push origin main v$VER' when ready."
fi
