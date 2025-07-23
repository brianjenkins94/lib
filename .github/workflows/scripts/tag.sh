#!/usr/bin/env bash

PACKAGE="$1"
VERSION="0.0.0"

if [[ -f docs/$PACKAGE@latest.tgz ]]; then
  VERSION=$(tar -xOzf docs/"$PACKAGE"@latest.tgz ./package.json | jq --raw-output '.version // "0.0.0"')
fi

if [[ -n "$(jq --raw-output '.version // empty' "$PACKAGE/package.json")" ]]; then
  VERSION=$(jq --raw-output '.version' "$PACKAGE/package.json")
fi

RELEASE=$(gh release list --limit 100 --json tagName --jq '[.[] | select(.tagName | startswith("'"$PACKAGE"'@")) | .tagName | sub("'"$PACKAGE"'@";"") | split(".") | map(tonumber)] | sort | last | if . == null then "" else map(tostring) | join(".") end')

if [[ -n "$RELEASE" ]] && pnpm exec semver "$RELEASE" --range ">$VERSION" >/dev/null; then
  VERSION="$RELEASE"
fi

VERSION=$(pnpm exec semver "$VERSION" --increment minor)

echo "$PACKAGE@$VERSION"
