#!/usr/bin/env bash
# Tags, releases, and publishes the version currently in package.json.
# Run after bumping the version and committing that change — this is the
# only step needed from there, so creating the GitHub release can't be
# forgotten as a separate manual step.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists." >&2
  exit 1
fi

if npm view "$(node -p "require('./package.json').name")@"$VERSION"" version >/dev/null 2>&1; then
  echo "$VERSION is already published to npm." >&2
  exit 1
fi

npm run lint
npm run build

git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"

gh release create "$TAG" --title "$TAG" --generate-notes

npm publish --access public

echo "Released and published $TAG."
