#!/usr/bin/env bash

# Fail loud, but still ship what built. NOT `set -e`: a single package's build/publish failure must not
# stop the others from being promoted (that's why this used to swallow errors). Instead, capture
# publish.ts's exit explicitly, promote every package that produced a fresh tarball, then propagate the
# failure at the very END — so a crash/build failure turns the run red without aborting the successes.
# (cd.yml keeps upload-pages-artifact + the deploy job on `if: !cancelled()` so the successes still ship.)
PACKAGES=("$@")

# Build + write tarballs + npm-publish (per-package; publish.ts records build failures and exits non-zero).
PUBLISH_STATUS=0
pnpm run publish || PUBLISH_STATUS=$?

FAILURES=0
SUCCESSES=0

for PACKAGE in "${PACKAGES[@]}"; do
  VERSION=$(tar -xOzf "docs/$PACKAGE@latest.tgz" package/package.json 2>/dev/null | jq --raw-output '.version // empty' || true)
  TAG_NAME="$PACKAGE@$VERSION"

  if [[ -z "$VERSION" ]]; then
    echo "❌ Could not determine TAG_NAME for $PACKAGE (docs/$PACKAGE@latest.tgz missing or has no version)"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  echo "📦 Releasing $TAG_NAME"

  if gh release view "$TAG_NAME" > /dev/null 2>&1; then
    gh release edit "$TAG_NAME" --draft=false
    echo "✅ Release $TAG_NAME marked as published"
    SUCCESSES=$((SUCCESSES + 1))
  else
    echo "⚠️  No draft release found for $TAG_NAME — skipping"
    FAILURES=$((FAILURES + 1))
  fi
done

if [[ $SUCCESSES -eq 0 ]]; then
  echo "❌ No packages were successfully published"
  exit 1
fi

# Propagate a build/publish failure now that the successful packages have been promoted above — so the
# job goes red (and a crashed publish.ts can never ship green again) without having blocked the successes.
if [[ $PUBLISH_STATUS -ne 0 ]]; then
  echo "❌ publish.ts reported build/publish failures (exit $PUBLISH_STATUS)"
  exit "$PUBLISH_STATUS"
fi

exit 0
