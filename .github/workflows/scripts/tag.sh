#!/usr/bin/env bash

PACKAGE="$1"

GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/null}"

VERSION="0.0.0"
if [[ -f docs/$PACKAGE@latest.tgz ]]; then
  VERSION=$(tar -xOzf docs/$PACKAGE@latest.tgz ./package.json | jq --raw-output '.version // "0.0.0"')
fi

PACKAGE_VERSION=$(jq --raw-output '.version // empty' "$PACKAGE/package.json")
if [[ -n "$PACKAGE_VERSION" ]]; then
  VERSION="$PACKAGE_VERSION"
fi

RELEASE_VERSION=$(gh release list --limit 100 --json tagName --jq \
  "[.[] | select(.tagName | startswith(\"$PACKAGE@\")) | .tagName | sub(\"$PACKAGE@\"; \"\") | split(\".\") | map(tonumber)] | sort | last | if . == null or . == \"\" then \"\" else map(tostring) | join(\".\") end"
)

if [[ -n "$RELEASE_VERSION" ]] && npx -y semver "$RELEASE_VERSION" -r ">$VERSION" > /dev/null; then
  VERSION="$RELEASE_VERSION"
fi

VERSION=${VERSION:-0.0.0}
BUMPED_VERSION=$(npx -y semver "$VERSION" -i minor)
BUMPED_VERSION=${BUMPED_VERSION:-0.1.0}

echo "TAG_NAME=$PACKAGE@$BUMPED_VERSION" >> "$GITHUB_OUTPUT"
