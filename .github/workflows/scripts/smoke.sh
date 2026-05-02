#!/usr/bin/env bash

PACKAGES=("$@")

for PACKAGE in "${PACKAGES[@]}"; do
  SCOPED="@${GITHUB_REPOSITORY_OWNER}/${PACKAGE}"
  URL="https://${GITHUB_REPOSITORY_OWNER}.github.io/${GITHUB_REPOSITORY#*/}/${PACKAGE}@latest.tgz"

  npm install --no-save "$URL"

  EXPORTS=$(jq -r --arg scope "$SCOPED" '.exports | keys[] | select(. != ".") | $scope + .[1:]' "node_modules/$SCOPED/package.json")

  npx tsx test/runtime/node.ts $EXPORTS
done
