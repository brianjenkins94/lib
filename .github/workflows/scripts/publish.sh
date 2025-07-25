#!/usr/bin/env bash

PACKAGES=("$@")

pnpm run publish

EXIT_CODE=0

for PACKAGE in "${PACKAGES[@]}"; do
  TAG_NAME=$(jq --raw-output 'select(.version != null and .version != "") | "\(.name)@\(.version)"' "$PACKAGE/package.json" || true)

  RELEASES=$(gh release list --json tagName)

  if [[ -z "$TAG_NAME" ]] || jq --raw-output '.[].tagName' <<< "$RELEASES" | grep -qx "$TAG_NAME"; then
    TAG_NAME="${PACKAGE}@$(jq --raw-output '([.[] | select(.tagName | startswith("'"$PACKAGE"'@")) | .tagName | sub("'"$PACKAGE"'@";"") | select(length > 0) | split(".") | map(tonumber)] | sort | last | if . == null or . == [] then [0,1,0] else . end | map(tostring) | join("."))' <<< "$RELEASES")"
  fi

  echo "📦 Releasing $TAG_NAME"

  #if pnpm run publish "$PACKAGE"; then
    echo "✅ Release $TAG_NAME marked as published"

    if gh release view "$TAG_NAME" > /dev/null 2>&1; then
      gh release edit "$TAG_NAME" --draft=false
    fi
  #fi
done

exit $EXIT_CODE
