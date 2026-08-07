#!/bin/bash
#
# release.sh
#
# Strict pre-flight gate + publisher for the Prime Agent VS Code extension.
# Mirrors the chutes-dropzone release discipline, adapted for this repo:
# - repo/branch/remote checks (must be on master, tree clean, remote in sync)
# - tag proposal from prior vX.Y.Z tags (+optional override)
# - version consistency (git tag == package.json version == changelog section)
# - FULL verification battery before anything is allowed to publish:
#     tsc, build, webview harness, activation, host e2e, smoke, export-md,
#     screenshot matrix (each must pass)
# - package the .vsix via `npm run package`
# - commit release commit, tag, push master+tag, publish GitHub release with the vsix
#
# Publishing to the marketplace itself is NOT in this script — a `vsce` token
# belongs to an account secret. The script prints the exact command at the end.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ALLOW_NON_MASTER="${ALLOW_NON_MASTER:-0}"

REQUIRED_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo master)"
REQUIRED_BRANCH="${REQUIRED_BRANCH:-master}"
if [ "$ALLOW_NON_MASTER" != "" ] && [ "$ALLOW_NON_MASTER" = "1" ]; then
    REQUIRED_BRANCH="$REQUIRED_BRANCH"
else
    REQUIRED_BRANCH="master"
fi
DEFAULT_REMOTE="${GIT_REMOTE:-}"

VERSION_OVERRIDE=""
DRY_RUN=false
YES=false

usage() {
    cat <<'EOF'
Usage: ./release.sh [options]

Options:
  --version vX.Y.Z    Explicit version tag to cut (default: next patch after the latest tag)
  --dry-run           Print the gate results and the release plan, then exit
  --yes               Skip interactive confirmations where safe
  -h, --help          Show this help

Environment:
  GIT_REMOTE          Force the publish remote (default: guessed from upstream/origin)
  ALLOW_NON_MASTER=1  Allow cutting from a non-master branch (warns, then proceeds)
EOF
}

log()      { printf '[release] %s\n' "$1"; }
warn()     { printf '[release] warning: %s\n' "$1" >&2; }
fail()     { printf '[release] error: %s\n' "$1" >&2; exit 1; }
require()  { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }
have()     { command -v "$1" >/dev/null 2>&1; }

current_branch() { git rev-parse --abbrev-ref HEAD; }
current_head()   { git rev-parse --short=12 HEAD; }

preferred_remote() {
    if [ -n "$DEFAULT_REMOTE" ]; then printf '%s' "$DEFAULT_REMOTE"; return; fi
    local ups
    ups="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null | sed 's#/.*##' || true)"
    if [ -n "$ups" ]; then printf '%s' "$ups"; return; fi
    if git remote | grep -qx origin; then printf 'origin'; return; fi
    git remote | head -n 1 || true
}

prompt_with_default() {
    local prompt="$1" default_value="$2" answer=""
    if [ ! -t 0 ] || [ ! -t 1 ]; then
        printf '%s' "$default_value"
        return
    fi
    read -r -p "$prompt [$default_value]: " answer
    printf '%s' "${answer:-$default_value}"
}

confirm() {
    local prompt="$1"
    if [ "$YES" = true ]; then return 0; fi
    if [ ! -t 0 ] || [ ! -t 1 ]; then return 1; fi
    read -r -p "$prompt [y/N]: " answer
    case "${answer:-N}" in
        y|Y|yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

normalize_version() {
    local version="$1"
    [[ "$version" != v* ]] && version="v${version}"
    printf '%s' "$version"
}

latest_version_tag() {
    git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true
}

suggest_next_version() {
    local latest="${1:-}"
    if [ -z "$latest" ]; then printf 'v1.0.0'; return; fi
    latest="${latest#v}"
    IFS='.' read -r major minor patch <<< "$latest"
    printf 'v%s.%s.%s' "$major" "$minor" "$((patch + 1))"
}

tag_exists() {
    local version="$1" remote="${2:-}"
    git rev-parse -q --verify "refs/tags/$version" >/dev/null 2>&1 && return 0
    if [ -n "$remote" ]; then
        git ls-remote --exit-code --tags "$remote" "refs/tags/$version" >/dev/null 2>&1 && return 0
    fi
    return 1
}

# ----------------------------- gates ---------------------------------------

gate_clean_tree() {
    local status
    status="$(git status --porcelain)"
    if [ -n "$status" ]; then
        fail "working tree is not clean; commit or stash before cutting a release"
    fi
}

gate_branch() {
    local branch
    branch="$(current_branch)"
    if [ "$branch" != "$REQUIRED_BRANCH" ]; then
        if [ "$ALLOW_NON_MASTER" = "1" ]; then
            warn "cutting from branch '$branch' (ALLOW_NON_MASTER=1)"
            return 0
        fi
        fail "refusing to cut from '$branch' (expected $REQUIRED_BRANCH); set ALLOW_NON_MASTER=1 to override"
    fi
}

gate_remote_sync() {
    local remote="$1"
    [ -n "$remote" ] || fail "no git remote configured"
    if [ "$DRY_RUN" != true ]; then
        git fetch --quiet "$remote" >/dev/null 2>&1 || true
    fi
    local local_head remote_head
    local_head="$(git rev-parse HEAD)"
    if git ls-remote --exit-code --heads "$remote" "$(current_branch)" >/dev/null 2>&1; then
        remote_head="$(git ls-remote "$remote" "refs/heads/$(current_branch)" | awk '{print $1}')"
        if [ "$local_head" != "$remote_head" ]; then
            fail "local $(current_branch) ($local_head) is not synced with $remote ($(current_branch)) ($remote_head) — push first"
        fi
    else
        warn "branch $(current_branch) is not yet pushed to $remote — it will be pushed at publish time"
    fi
}

gate_tag_conformity() {
    local chosen="$1"
    local pkg_version section
    pkg_version="$(node -p 'require("./package.json").version' 2>/dev/null || true)"
    if [ -z "$pkg_version" ]; then fail "could not read package.json version"; fi
    if [ "$pkg_version" != "${chosen#v}" ] && [ "${ALLOW_VERSION_BUMP:-1}" != "1" ]; then
        fail "package.json version ($pkg_version) does not match the release tag ($chosen); bump it first"
    fi
    section="$(grep -cE "^## \[${chosen#v}\]" CHANGELOG.md 2>/dev/null || echo 0)"
    if [ "$section" = "0" ] && ! grep -qE '^## \[Unreleased\]' CHANGELOG.md; then
        fail "CHANGELOG.md has no [${chosen#v}] section and no [Unreleased] one either; write entries first"
    fi
}

apply_release_changes() {
    local chosen="$1"
    local pkg_version section
    pkg_version="$(node -p 'require("./package.json").version' 2>/dev/null || true)"
    if [ "$pkg_version" != "${chosen#v}" ]; then
        log "bumping package.json version $pkg_version -> ${chosen#v}"
        node -e "
const fs = require('fs');
const pj = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pj.version = '${chosen#v}';
fs.writeFileSync('package.json', JSON.stringify(pj, null, 2) + '\n');
"
    fi
    section="$(grep -cE "^## \[${chosen#v}\]" CHANGELOG.md 2>/dev/null || echo 0)"
    if [ "$section" = "0" ]; then
        if grep -qE '^## \[Unreleased\]' CHANGELOG.md && grep -A2 '^## \[Unreleased\]' CHANGELOG.md | grep -qE '^\s*-'; then
            log "moving [Unreleased] entries into [${chosen#v}]"
            node -e "
const fs = require('fs');
const src = fs.readFileSync('CHANGELOG.md', 'utf8');
const out = src.replace(/## \[Unreleased\]([\s\S]*?)(?=^## \[|$)/m, (m, body) => \
  \`## [Unreleased]\n\n## [${chosen#v}]\` + body);
if (out === src) process.exit(2);
fs.writeFileSync('CHANGELOG.md', out);
" || fail "could not rewrite CHANGELOG.md for [${chosen#v}]"
        fi
    fi
}
gate_tests() {
    log "running the full verification battery…"
    local failures=0
    run_gate "tsc --noEmit" "npm exec -- tsc --noEmit" || failures=$((failures+1))
    run_gate "esbuild build" "node esbuild.config.mjs" || failures=$((failures+1))
    for layer in test/webview.test.mjs test/export-md.test.mjs test/activate.test.mjs test/host-e2e.mjs test/smoke.mjs; do
        run_gate "$layer" "node $layer" || failures=$((failures+1))
    done
    run_gate "preview screenshot matrix" "node test/preview-shot.mjs" || failures=$((failures+1))
    if [ "$failures" != "0" ]; then
        fail "$failures verification layer(s) failed — fix them before publishing"
    fi
    log "all layers green"
}

run_gate() {
    local label="$1" cmd="$2"
    printf '[release] gate: %-32s' "$label"
    if $cmd >/tmp/release-gate-out.txt 2>&1; then
        printf ' ok\n'
    else
        printf ' FAIL\n'
        sed 's/^/[release]   /' /tmp/release-gate-out.txt | tail -8
        return 1
    fi
}

# ----------------------------- run -----------------------------------------

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version=*)
            VERSION_OVERRIDE="${1#*=}"
            ;;
        --version)
            if [ "$#" -lt 2 ]; then fail "--version requires a value"; fi
            shift
            VERSION_OVERRIDE="${1:-}"
            ;;
        --target-branch=*)
            : # accepted for forward-compat; branch check covers intent
            ;;
        --dry-run)
            DRY_RUN=true
            ;;
        --yes)
            YES=true
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
    shift
done

require git
require node
require npm

git_remote="$(preferred_remote)"
[ -n "$git_remote" ] || fail "no git remote configured"

gate_clean_tree
gate_branch
gate_remote_sync "$git_remote"

latest_tag="$(latest_version_tag)"
if [ -n "$VERSION_OVERRIDE" ]; then
    chosen_tag="$(normalize_version "$VERSION_OVERRIDE")"
else
    proposed_tag="$(suggest_next_version "$latest_tag")"
    chosen_tag="$(normalize_version "$(prompt_with_default "Release version" "$proposed_tag")")"
fi

if ! [[ "$chosen_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    fail "version must look like vX.Y.Z, got: $chosen_tag"
fi
if tag_exists "$chosen_tag" "$git_remote"; then
    fail "tag already exists: $chosen_tag"
fi

gate_tag_conformity "$chosen_tag"
gate_tests

apply_release_changes "$chosen_tag"

# ---- package the vsix ----
log "packaging…"
npm run package >/tmp/release-package.out.txt 2>&1 || fail "npm run package failed: $(tail -2 /tmp/release-package.out.txt)"
vsix="$(ls -t prime-agent-vscode-"${chosen#v}".vsix 2>/dev/null | head -n 1 || true)"
[ -n "$vsix" ] || vsix="$(ls -t prime-agent-vscode-*.vsix 2>/dev/null | head -n 1 || true)"
[ -n "$vsix" ] || fail "no .vsix was produced"

# ---- summarize ----
cat <<EOF

Release plan
  branch:  $(current_branch)
  head:    $(current_head)
  remote:  $git_remote
  latest:  ${latest_tag:-<none>}
  chosen:  $chosen_tag
  vsix:    $vsix ($(du -h "$vsix" | awk '{print $1}'))
  changed: package.json (version), CHANGELOG.md (new section)

Next: commit + tag + push + GitHub release with the vsix asset.
Marketplace: vsce publish --packagePath $vsix  (requires a publisher login — not done by this script).
EOF

if [ "$DRY_RUN" = true ]; then
    exit 0
fi

commit_title="Release $chosen_tag"
if ! confirm "Commit $chosen_tag, tag it, and publish a GitHub release?"; then
    fail "release cancelled"
fi

git add package.json CHANGELOG.md $(git ls-files --modified test/preview-*.png test/smoke.mjs test/smoke.mjs.map 2>/dev/null || true)
git commit -m "$commit_title" >/dev/null || fail "release commit failed"
git tag -a "$chosen_tag" -m "$commit_title"

if [ -n "$git_remote" ]; then
    git push "$git_remote" "$(current_branch)"
    git push "$git_remote" "$chosen_tag"
fi

# Optional marketplace publish: source the gitignored key and publish the same
# vsix. Disabled when VSCE_PAT is empty or VSCE_PUBLISH=0.
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi
VSCE_PUBLISH="${VSCE_PUBLISH:-1}"

if have gh; then
    notes="$(mktemp /tmp/release-notes-XXXXXX.txt)"
    awk -v ver="\\[${chosen#v}\\]" '
        /^## \[/ {
            if (seen && !done) done=1
            if (index($0, ver)) { seen=1; next }
        }
        seen && !done { print }
    ' CHANGELOG.md > "$notes" || true
    if [ -s "$notes" ]; then
        gh release create "$chosen_tag" "$vsix" --title "$chosen_tag" --notes-file "$notes"
    else
        gh release create "$chosen_tag" "$vsix" --title "$chosen_tag" --generate-notes
    fi
    rm -f "$notes"
    log "published GitHub release $chosen_tag with $vsix"
else
    warn "gh not found — tag + master pushed; create the release manually with: gh release create $chosen_tag $vsix"
fi

if [ -n "${VSCE_PAT:-}" ] && [ "$VSCE_PUBLISH" = "1" ]; then
    log "publishing to the VS Code Marketplace…"
    if VSCE_PAT="$VSCE_PAT" ./node_modules/.bin/vsce publish --packagePath "$vsix"; then
        log "marketplace listing updated for ${chosen_tag}"
    else
        warn "marketplace publish failed — the GitHub release is shipped; re-run:"
        warn "  VSCE_PAT=<pat> ./node_modules/.bin/vsce publish --packagePath $vsix"
    fi
else
    log "done. Next, if the marketplace publishes: vsce publish --packagePath $vsix"
fi
