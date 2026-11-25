#!/bin/sh
set -eu

usage() {
  echo 'usage: classify-ci-changes.sh --git <base-sha> <head-sha>' >&2
  echo '       classify-ci-changes.sh --files' >&2
  exit 2
}

classify_files() {
  _files="$1"
  if [ -z "$_files" ]; then
    go=true
    node=true
    release_metadata=true
    must_run_main=true
    return
  fi
  go=false
  node=false
  release_metadata=false
  must_run_main=false
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    case "$path" in
      .release-please-manifest.json|catalog/*)
        must_run_main=true
        ;;
    esac
    case "$path" in
      .release-please-manifest.json|release-please-config.json|.github/workflows/*|scripts/classify-ci-changes.sh)
        go=true
        node=true
        release_metadata=true
        ;;
      package.json|package-lock.json)
        node=true
        release_metadata=true
        ;;
      LICENSE*|*/LICENSE*|NOTICE*|*/NOTICE*|*THIRD_PARTY*|*LICENSES*)
        go=true
        node=true
        ;;
      catalog/*.go)
        go=true
        ;;
      catalog/*)
        go=true
        node=true
        ;;
      *.md|docs/*.md|.github/ISSUE_TEMPLATE/*|.github/PULL_REQUEST_TEMPLATE.md)
        ;;
      scripts/*.mjs)
        node=true
        ;;
      cmd/*|platform/*|schemas/*|go.mod|go.sum|*.go)
        go=true
        ;;
      *)
        go=true
        node=true
        release_metadata=true
        ;;
    esac
  done <<EOF
$_files
EOF
}

mode="${1:-}"
go=true
node=true
release_metadata=true
must_run_main=true

case "$mode" in
  --git)
    [ "$#" -eq 3 ] || usage
    merge_base="$(git merge-base "$2" "$3")"
    changed="$(git -c core.quotePath=false diff --no-renames --name-only "$merge_base" "$3" --)"
    classify_files "$changed"
    ;;
  --files)
    [ "$#" -eq 1 ] || usage
    changed="$(cat)"
    classify_files "$changed"
    ;;
  *)
    usage
    ;;
esac

printf 'go=%s\nnode=%s\nrelease_metadata=%s\nmust_run_main=%s\n' \
  "$go" "$node" "$release_metadata" "$must_run_main"
