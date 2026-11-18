#!/usr/bin/env bash
# Publishes the learning reports to the `reports` branch of origin, where the
# weekly Claude review reads them. Needs push access to origin. Leaves the
# current checkout alone: the branch is built in a temporary worktree.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${REPORTS_SRC:-$ROOT/apps/engine/reports}"
BRANCH="${REPORTS_BRANCH:-reports}"

if ! compgen -G "$SRC/*.md" > /dev/null; then
  echo "no reports in $SRC yet"
  exit 0
fi

WORK="$(mktemp -d)"
cleanup() {
  git -C "$ROOT" worktree remove --force "$WORK" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

cd "$ROOT"
if git fetch -q origin "$BRANCH" 2> /dev/null; then
  git worktree add -q --force -B "$BRANCH" "$WORK" FETCH_HEAD
else
  git worktree add -q --force --detach "$WORK"
  git -C "$WORK" checkout -q --orphan "$BRANCH"
  git -C "$WORK" rm -rq --cached . > /dev/null 2>&1 || true
  find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
fi

mkdir -p "$WORK/reports"
cp "$SRC"/*.md "$WORK/reports/"
cp "$SRC"/*.json "$WORK/reports/" 2> /dev/null || true
git -C "$WORK" add reports
if git -C "$WORK" diff --cached --quiet; then
  echo "origin/$BRANCH is already up to date"
  exit 0
fi
git -C "$WORK" -c user.name="sniper-bot" -c user.email="sniper-bot@users.noreply.github.com" \
  commit -q -m "Reports $(date -u +%F)"
git -C "$WORK" push -q origin "$BRANCH"
echo "pushed $(ls "$WORK/reports" | wc -l | tr -d ' ') report files to origin/$BRANCH"
