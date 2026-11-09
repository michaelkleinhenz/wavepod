#!/usr/bin/env bash
# Cut a release: set the version in package.json/package-lock.json, commit,
# tag vX.Y.Z and push both. The tag starts .github/workflows/release.yml.
#
#   scripts/release.sh 0.7.0          (or: make release VERSION=0.7.0)
#
# Environment:
#   REMOTE=origin          remote to push to
#   RELEASE_BRANCH=main    branch releases are cut from
#   YES=1                  skip the confirmation prompt
set -euo pipefail

die() { echo "release: $*" >&2; exit 1; }

version="${1:-}"
version="${version#v}"
remote="${REMOTE:-origin}"
branch="${RELEASE_BRANCH:-main}"

[ -n "$version" ] || die "usage: make release VERSION=x.y.z"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] \
  || die "'$version' is not a version like 1.2.3 or 1.2.3-beta.1"
tag="v$version"

cd "$(git rev-parse --show-toplevel)"

current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
[ "$current_branch" = "$branch" ] \
  || die "releases are cut from '$branch', you are on '${current_branch:-a detached HEAD}' (set RELEASE_BRANCH to override)"
[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes"

git fetch --quiet --tags "$remote" "$branch"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$remote/$branch")" ] \
  || die "'$branch' is not in sync with '$remote/$branch'; pull or push first"
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "tag $tag already exists"
[ -z "$(git ls-remote --tags "$remote" "refs/tags/$tag")" ] || die "tag $tag already exists on $remote"

old="$(node -p "require('./package.json').version")"
echo "Release $tag: package.json $old -> $version, commit, tag and push to $remote ($branch)."
if [ "${YES:-}" != "1" ]; then
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || die "aborted"
fi

npm version --no-git-tag-version --allow-same-version "$version" >/dev/null
git add package.json package-lock.json
if git diff --cached --quiet; then
  echo "package.json is already at $version, tagging the current commit."
else
  git commit --quiet -m "Release $tag"
fi
git tag -a "$tag" -m "WavePod $tag"

# Branch and tag go up together, so a rejected push leaves no stray tag on the remote.
if ! git push --atomic "$remote" "HEAD:refs/heads/$branch" "refs/tags/$tag"; then
  die "push failed; the commit and tag $tag exist only locally (undo with: git tag -d $tag && git reset --hard $remote/$branch)"
fi

echo "Pushed $tag. The release workflow builds the installers: https://github.com/michaelkleinhenz/wavepod/actions/workflows/release.yml"
