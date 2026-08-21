#!/bin/bash
#
# release.sh
#
# Strict pre-flight gate + publisher for the Prime Agent VS Code extension.
# Mirrors the chutes-dropzone release discipline, adapted for this repo:
# - repo/branch/remote checks (must be on master, tree clean, remote in sync)
# - tag proposal from prior vX.Y.Z tags (+optional override)
# - version consistency: package.json and package-lock.json are bumped to the
#   tag and the [Unreleased] changelog entries are promoted into a [X.Y.Z]
#   section
# - FULL verification battery before anything is allowed to publish:
#     tsc, build, activation, webview, thread-diffs, export-md,
#     recent-sessions, daemon parity, host e2e, smoke, screenshot matrix
#     (each must pass)
# - package the .vsix via `npm run package`
# - commit release commit, tag, push master+tag, publish GitHub release with the vsix
#
# Marketplace publishing is owned by the GitHub release: creating it triggers
# .github/workflows/publish.yml, which runs `vsce publish` with the repo's
# VSCE_PAT secret. This script waits for that run and reports its real outcome.
# VSCE_PUBLISH=1 publishes from the local .env instead (see the plan block).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ALLOW_NON_MASTER="${ALLOW_NON_MASTER:-0}"
# The script bumps package.json to the chosen tag by design; set this to 0 to
# demand the package metadata bump was made by hand first.
ALLOW_VERSION_BUMP="${ALLOW_VERSION_BUMP:-1}"

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
  --dry-run           Run the gates, print the plan, then exit — edits nothing
  --yes               Skip interactive confirmations where safe
  -h, --help          Show this help

Environment:
  GIT_REMOTE            Force the publish remote (default: guessed from upstream/origin)
  ALLOW_NON_MASTER=1    Allow cutting from a non-master branch (warns, then proceeds)
  ALLOW_VERSION_BUMP=0  Refuse to bump package.json; the version must already match the tag
  VSCE_PUBLISH=1        Publish to the marketplace from .env instead of letting the
                        GitHub release's publish.yml workflow do it
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

# Whether publish.yml can actually publish. Reported in the plan block so a
# missing repo secret is visible before the release is cut, not after it red-Xes.
repo_secret_state() {
    have gh || { printf 'gh is not installed, so this run cannot check it'; return; }
    local names environment_names
    names="$(gh secret list --json name -q '.[].name' 2>/dev/null || true)"
    if printf '%s\n' "$names" | grep -qx VSCE_PAT; then
        printf 'VSCE_PAT repo secret is set'
        return
    fi
    # publish.yml deliberately scopes VSCE_PAT to the CI environment so pull
    # requests cannot access it. Check that scope too; otherwise the release
    # plan would incorrectly warn about a secret the publish job can use.
    environment_names="$(gh secret list --env CI --json name -q '.[].name' 2>/dev/null || true)"
    if printf '%s\n' "$environment_names" | grep -qx VSCE_PAT; then
        printf 'VSCE_PAT CI environment secret is set'
    elif [ -z "$names" ] && [ -z "$environment_names" ]; then
        printf 'this run could not read the repo or CI environment secrets'
    else
        printf 'VSCE_PAT repo secret is NOT set — that run will fail'
    fi
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
    local pkg_version lock_version lock_root_version section
    pkg_version="$(node -p 'require("./package.json").version' 2>/dev/null || true)"
    if [ -z "$pkg_version" ]; then fail "could not read package.json version"; fi
    lock_version="$(node -p 'require("./package-lock.json").version' 2>/dev/null || true)"
    lock_root_version="$(node -p 'require("./package-lock.json").packages?.[""]?.version || ""' 2>/dev/null || true)"
    if [ "$lock_version" != "$pkg_version" ] || [ "$lock_root_version" != "$pkg_version" ]; then
        fail "package-lock.json version metadata ($lock_version/$lock_root_version) does not match package.json ($pkg_version)"
    fi
    if [ "$pkg_version" != "${chosen#v}" ] && [ "$ALLOW_VERSION_BUMP" != "1" ]; then
        fail "package.json version ($pkg_version) does not match the release tag ($chosen); bump it first"
    fi
    # grep -c prints 0 AND exits 1 on no match, so `|| echo 0` used to yield the
    # two-line string "0\n0" and every "$section" = "0" test below silently failed.
    if grep -qE "^## \[${chosen#v}\]" CHANGELOG.md 2>/dev/null; then section=1; else section=0; fi
    if [ "$section" = "0" ] && ! grep -qE '^## \[Unreleased\]' CHANGELOG.md; then
        fail "CHANGELOG.md has no [${chosen#v}] section and no [Unreleased] one either; write entries first"
    fi
    local unreleased
    unreleased="$(grep -cE '^## \[Unreleased\]' CHANGELOG.md 2>/dev/null || true)"
    if [ "${unreleased:-0}" -gt 1 ]; then
        warn "CHANGELOG.md has ${unreleased} [Unreleased] headings — only the first becomes [${chosen#v}]; merge them or the rest ship unlabelled"
    fi
}

# Sets VERSION_STATUS / CHANGELOG_STATUS so the plan block can report what this
# actually did instead of asserting a rewrite that may not have happened.
# $2=true describes the edits without making them: a --dry-run that bumped
# package.json would leave a dirty tree that blocks the next real cut.
apply_release_changes() {
    local chosen="$1" dry="${2:-false}" bumped="bumped" promoted="promoted"
    local pkg_version section
    if [ "$dry" = true ]; then bumped="would bump"; promoted="would promote"; fi
    pkg_version="$(node -p 'require("./package.json").version' 2>/dev/null || true)"
    VERSION_STATUS="already ${chosen#v}"
    if [ "$pkg_version" != "${chosen#v}" ]; then
        VERSION_STATUS="$bumped $pkg_version -> ${chosen#v}"
        if [ "$dry" != true ]; then
            log "bumping package metadata $pkg_version -> ${chosen#v}"
            node -e "
const fs = require('fs');
const pj = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const version = '${chosen#v}';
if (lock.name !== pj.name || !lock.packages || !lock.packages['']) {
  throw new Error('package-lock.json does not describe the root package');
}
pj.version = version;
lock.version = version;
lock.packages[''].version = version;
fs.writeFileSync('package.json', JSON.stringify(pj, null, 2) + '\n');
fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
"
        fi
    fi
    if grep -qE "^## \[${chosen#v}\]" CHANGELOG.md 2>/dev/null; then section=1; else section=0; fi
    CHANGELOG_STATUS="[${chosen#v}] section already written"
    if [ "$section" = "0" ]; then
        CHANGELOG_STATUS="NO section for ${chosen#v} — [Unreleased] is empty, this release ships unlabelled"
        if grep -qE '^## \[Unreleased\]' CHANGELOG.md && grep -A2 '^## \[Unreleased\]' CHANGELOG.md | grep -qE '^\s*-'; then
            CHANGELOG_STATUS="$promoted [Unreleased] into [${chosen#v}]"
            if [ "$dry" = true ]; then return 0; fi
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
    # The compare-link block is part of the changelog we are about to TAG and
    # ship inside the vsix. Leaving it to a manual follow-up commit meant every
    # release so far carried a [X.Y.Z] heading with no matching link definition —
    # `git show vX.Y.Z:CHANGELOG.md` proves it. Do it before the tag instead.
    if [ "$dry" != true ]; then
        node -e "
const fs = require('fs');
const src = fs.readFileSync('CHANGELOG.md', 'utf8');
const next = '${chosen}';
const match = src.match(/^\[Unreleased\]: (.*)\/compare\/(v[0-9]+\.[0-9]+\.[0-9]+)\.\.\.HEAD\$/m);
if (!match) process.exit(0);
const [line, base, prev] = match;
if (prev === next) process.exit(0);
const out = src.replace(line, \`[Unreleased]: \${base}/compare/\${next}...HEAD\n[\${next.slice(1)}]: \${base}/compare/\${prev}...\${next}\`);
fs.writeFileSync('CHANGELOG.md', out);
" || warn "could not update the CHANGELOG compare links; do it by hand after the cut"
    fi
}
gate_tests() {
    log "running the full verification battery…"
    local failures=0
    run_gate "tsc --noEmit" "npm exec -- tsc --noEmit" || failures=$((failures+1))
    run_gate "esbuild build" "node esbuild.config.mjs" || failures=$((failures+1))
    for layer in test/activate.test.mjs test/chat-view-message.test.mjs test/session-controller-boundary.test.mjs test/attach-lifecycle.test.mjs test/session-actions.test.mjs test/webview.test.mjs test/transcript-window.test.mjs test/thread-diffs.test.mjs test/export-md.test.mjs test/recent-sessions-tail.test.mjs test/transport-regression.test.mjs test/owner-visibility.test.mjs; do
        run_gate "$layer" "node $layer" || failures=$((failures+1))
    done
    run_gate "daemon parity" "node test/daemon-parity.mjs --require-daemon" || failures=$((failures+1))
    run_gate "owned roster" "node test/owned-roster.mjs --require-daemon" || failures=$((failures+1))
    for layer in test/host-e2e.mjs test/smoke.mjs; do
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

apply_release_changes "$chosen_tag" "$DRY_RUN"

# ---- package the vsix ----
# vsce globs with dot:true and never reads .gitignore, so only .vscodeignore
# keeps anything out of the published (and publicly downloadable) vsix. This was
# a denylist of one filename (.env) and therefore could not catch the next thing
# that showed up untracked: graphify-out shipped 4 MB of symbol map naming the
# very sources .vscodeignore excludes. Assert the whole file set instead — a
# denylist only ever knows about yesterday's mistake.
unexpected="$(./node_modules/.bin/vsce ls --no-dependencies 2>/dev/null | grep -vE '^(package\.json|README\.md|LICENSE|CHANGELOG\.md|dist/extension\.js|media/(main\.js|main\.css|panels\.css|icon\.png|icon\.svg))$' || true)"
if [ -n "$unexpected" ]; then
    printf '[release] refusing to package: unexpected files would ship inside the .vsix:\n' >&2
    printf '%s\n' "$unexpected" | sed 's/^/[release]   /' >&2
    fail "add them to .vscodeignore (or extend the allowlist in release.sh if they belong)"
fi
# Exact name, not `ls -t`: stale vsix files pile up in this directory and an
# mtime race would publish the wrong bundle under the new tag.
vsix="prime-agent-vscode-${chosen_tag#v}.vsix"
if [ "$DRY_RUN" = true ]; then
    vsix_line="$vsix (not built — dry run)"
else
    log "packaging…"
    npm run package >/tmp/release-package.out.txt 2>&1 || fail "npm run package failed: $(tail -2 /tmp/release-package.out.txt)"
    [ -f "$vsix" ] || fail "npm run package did not produce $vsix"
    vsix_line="$vsix ($(du -h "$vsix" | awk '{print $1}'))"
fi

# ---- who publishes to the marketplace ----
# Decided BEFORE the plan block so the plan can state what will actually happen.
# The GitHub release triggers .github/workflows/publish.yml; publishing locally
# as well would mean two racing publishers and one confusing failure.
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi
VSCE_PUBLISH="${VSCE_PUBLISH:-0}"
publish_local=false
if [ "$VSCE_PUBLISH" = "1" ]; then
    if [ -n "${VSCE_PAT:-}" ]; then
        publish_local=true
    else
        warn "VSCE_PUBLISH=1 but no VSCE_PAT in .env — leaving the publish to the workflow"
    fi
fi

if [ "$publish_local" = true ]; then
    market_line="THIS SCRIPT publishes ${chosen_tag#v} from .env, before creating the release.
             publish.yml then runs too and will report a duplicate version.
             Unset VSCE_PUBLISH to let the workflow own it."
else
    market_line="the GitHub release triggers .github/workflows/publish.yml, which
             runs vsce publish ($(repo_secret_state)). This script waits for
             that run. VSCE_PUBLISH=1 publishes from .env instead."
fi

# ---- summarize ----
cat <<EOF

Release plan
  branch:  $(current_branch)
  head:    $(current_head)
  remote:  $git_remote
  latest:  ${latest_tag:-<none>}
  chosen:  $chosen_tag
  vsix:    $vsix_line
  version: package.json ${VERSION_STATUS}
  changes: CHANGELOG.md ${CHANGELOG_STATUS}

Next: commit + tag + push + GitHub release with the vsix asset.
Marketplace: $market_line
EOF

if [ "$DRY_RUN" = true ]; then
    exit 0
fi

commit_title="Release $chosen_tag"
if [ "$publish_local" = true ]; then
    confirm_prompt="Commit $chosen_tag, tag it, PUBLISH TO THE PUBLIC VS CODE MARKETPLACE, and publish a GitHub release?"
else
    confirm_prompt="Commit $chosen_tag, tag it, and publish a GitHub release (which publishes it to the PUBLIC VS Code Marketplace)?"
fi
if ! confirm "$confirm_prompt"; then
    fail "release cancelled"
fi

# test/preview-*.png are regenerated by the screenshot gate above and are now
# untracked (.gitignore). Folding their byte churn into the release commit is
# what used to leave the tree dirty and abort the NEXT cut at gate_clean_tree.
git add package.json package-lock.json CHANGELOG.md
git commit -m "$commit_title" >/dev/null || fail "release commit failed"
git tag -a "$chosen_tag" -m "$commit_title"

if [ -n "$git_remote" ]; then
    git push "$git_remote" "$(current_branch)"
    git push "$git_remote" "$chosen_tag"
fi

# Local publish goes FIRST when it is armed: the release event below starts the
# workflow, and whichever publisher finishes second reports a duplicate version.
# Ordering it here makes the winner the one the operator confirmed.
if [ "$publish_local" = true ]; then
    log "publishing ${chosen_tag#v} to the VS Code Marketplace from .env…"
    if VSCE_PAT="$VSCE_PAT" ./node_modules/.bin/vsce publish --packagePath "$vsix"; then
        log "marketplace listing updated for ${chosen_tag}"
    else
        warn "marketplace publish failed — continuing with the GitHub release; re-run:"
        warn "  VSCE_PAT=<pat> ./node_modules/.bin/vsce publish --packagePath $vsix"
    fi
fi

if have gh; then
    notes="$(mktemp /tmp/release-notes-XXXXXX.txt)"
    awk -v ver="\\[${chosen_tag#v}\\]" '
        /^## \[/ {
            if (seen && !done) done=1
            if (index($0, ver)) { seen=1; next }
        }
        seen && !done { print }
    ' CHANGELOG.md > "$notes" || true
    if [ -s "$notes" ]; then
        gh release create "$chosen_tag" "$vsix" --title "$chosen_tag" --notes-file "$notes"
    else
        warn "no [${chosen_tag#v}] section in CHANGELOG.md — the release notes fall back to the generated commit list"
        gh release create "$chosen_tag" "$vsix" --title "$chosen_tag" --generate-notes
    fi
    rm -f "$notes"
    log "published GitHub release $chosen_tag with $vsix"
else
    warn "gh not found — tag + master pushed; create the release manually with: gh release create $chosen_tag $vsix"
    warn "creating that release is what publishes ${chosen_tag#v} to the marketplace"
fi

# The release event queued publish.yml. Report its real outcome instead of
# leaving the operator to guess which of the two signals is authoritative.
if have gh && [ "$publish_local" = true ]; then
    log "publish.yml also runs for this release; ${chosen_tag#v} is already published, so that run will fail on the duplicate"
elif have gh; then
    head_sha="$(git rev-parse HEAD)"
    run_id=""
    tries=0
    log "waiting for the marketplace publish workflow (Ctrl-C is safe — the release is already pushed)…"
    while [ "$tries" -lt 12 ]; do
        run_id="$(gh run list --workflow=publish.yml --limit=20 --json databaseId,headSha,event \
            -q "map(select(.headSha == \"$head_sha\" and .event == \"release\")) | .[0].databaseId" 2>/dev/null || true)"
        case "$run_id" in ""|null) ;; *) break ;; esac
        run_id=""
        tries=$((tries + 1))
        sleep 5
    done
    if [ -z "$run_id" ]; then
        warn "publish.yml has not started a run for $chosen_tag yet — check the Actions tab: gh run list --workflow=publish.yml"
    else
        # `gh run watch` only draws progress; the verdict comes from the run
        # itself, because watch also errors on already-finished runs.
        gh run watch "$run_id" || true
        case "$(gh run view "$run_id" --json conclusion -q .conclusion 2>/dev/null || true)" in
            success)
                log "marketplace listing updated for ${chosen_tag} (publish.yml run $run_id)"
                ;;
            ""|null)
                warn "publish.yml run $run_id has no result yet — follow it: gh run watch $run_id"
                ;;
            *)
                warn "publish.yml run $run_id did not publish ${chosen_tag#v} to the marketplace"
                warn "  why:       gh run view $run_id --log-failed"
                warn "  publish from here: VSCE_PAT=<pat> ./node_modules/.bin/vsce publish --packagePath $vsix"
                ;;
        esac
    fi
fi
