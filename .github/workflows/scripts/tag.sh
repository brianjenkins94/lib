#!/usr/bin/env bash

PACKAGE="$1"
ARCHIVE_VERSION="0.0.0"

if [[ -f docs/$PACKAGE@latest.tgz ]]; then
  ARCHIVE_VERSION=$(tar -xOzf docs/"$PACKAGE"@latest.tgz package.json | jq --raw-output '.version // "0.0.0"')
fi

VERSION="$ARCHIVE_VERSION"

PACKAGE_JSON_VERSION=$(jq --raw-output '.version // empty' "$PACKAGE/package.json")

if [[ -n "$PACKAGE_JSON_VERSION" ]]; then
  VERSION="$PACKAGE_JSON_VERSION"
fi

RELEASE=$(gh release list --limit 100 --json tagName --jq '[.[] | select(.tagName | startswith("'"$PACKAGE"'@")) | .tagName | sub("'"$PACKAGE"'@";"") | split(".") | map(tonumber)] | sort | last | if . == null then "" else map(tostring) | join(".") end')

if [[ -n "$RELEASE" ]] && pnpm exec semver "$RELEASE" --range ">$VERSION" >/dev/null; then
  VERSION="$RELEASE"
fi

# Only auto-increment if no explicit version bump was made
if [[ "$VERSION" == "$ARCHIVE_VERSION" ]]; then
  VERSION=$(pnpm exec semver "$VERSION" --increment minor)
fi

# If this version is already published (not a draft), increment to avoid collision
IS_DRAFT=$(gh release view "$PACKAGE@$VERSION" --json isDraft --jq '.isDraft' 2>/dev/null || echo "")
if [[ "$IS_DRAFT" == "false" ]]; then
  VERSION=$(pnpm exec semver "$VERSION" --increment minor)
fi

echo "$PACKAGE@$VERSION"
