#!/usr/bin/env bash
# repo:init — onboard a new child repo into Sunday (M5.4).
#
#   npm run repo:init <git-url> [name] [-- --dry-run]
#
# Automates the GENERIC, mechanical parts of onboarding: clone the child into
# repos/<name>, scaffold .sandcastle/ (Dockerfile template + .gitignore + blank .env),
# add its routing entry to the gitignored config/repos.json, seed the pipeline labels
# on its GitHub tracker, and regenerate the editor workspace. The CHILD-SPECIFIC bits —
# a Dockerfile `FROM` the child's own dev image, building the sandbox image, any test
# sidecar — need your judgement and are printed as next-steps (see the onboarding
# recipe). Idempotent + additive: never overwrites an existing child or config entry.
#
# --dry-run prints every action and touches nothing (no clone, no writes, no network).
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

DRY=0
args=()
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1 || args+=("$a"); done
set -- "${args[@]:-}"

url="${1:-}"
if [ -z "$url" ]; then
  echo "usage: npm run repo:init <git-url> [name] [-- --dry-run]" >&2
  exit 2
fi

# Derive owner/repo + a local name from the URL (https or ssh form).
slug="${url%.git}"; slug="${slug#*github.com[:/]}"; slug="${slug#https://github.com/}"; slug="${slug#git@github.com:}"
owner="${slug%%/*}"
repo="${slug##*/}"
name="${2:-$repo}"
full="${owner}/${repo}"
dir="repos/${name}"
image="${name}-sandbox:latest"

if [ -z "$owner" ] || [ -z "$repo" ] || [ "$owner" = "$slug" ]; then
  echo "✗ could not parse owner/repo from '$url' (expected a github.com URL)" >&2
  exit 2
fi

run() { if [ "$DRY" = 1 ]; then echo "  [dry] $*"; else eval "$*"; fi; }
say() { echo "$*"; }

tag=""; [ "$DRY" = 1 ] && tag="  [DRY-RUN]"
say "Onboarding ${full} → ${dir} (image ${image})${tag}"

# 1. Clone (skip if already present).
if [ -d "$dir" ]; then
  say "· clone: ${dir} exists — skipping"
else
  run "gh repo clone '${full}' '${dir}'"
fi

# 1b. Keep pipeline/floor scratch (e.g. an injected sub-agent's .scratch/ plan dir)
#     out of the child's worktree via the LOCAL .git/info/exclude — never committed,
#     so it never leaks into a PR or touches the child's own tracked .gitignore.
ex="${dir}/.git/info/exclude"
if [ "$DRY" = 1 ]; then
  say "  [dry] add .scratch/ to ${ex}"
elif [ -d "${dir}/.git" ]; then
  mkdir -p "$(dirname "$ex")"
  grep -qxF '.scratch/' "$ex" 2>/dev/null || printf '# Sunday: keep pipeline/floor scratch out of the worktree\n.scratch/\n' >> "$ex"
  say "· exclude: .scratch/ (local, not committed)"
else
  say "· exclude: skipped — ${dir}/.git not found (clone first)"
fi

# 2. Scaffold .sandcastle/ (Dockerfile TEMPLATE + .gitignore + blank .env). Never
#    overwrite — a child may already carry its own tuned .sandcastle/.
sc="${dir}/.sandcastle"
if [ -d "$sc" ] && [ "$DRY" = 0 ]; then
  say "· .sandcastle exists — leaving it untouched"
else
  run "mkdir -p '${sc}'"
  if [ "$DRY" = 1 ]; then
    say "  [dry] write ${sc}/{Dockerfile,.gitignore,.env}"
  else
    cat > "${sc}/Dockerfile" <<'DOCKER'
# EDIT ME: base this on YOUR child's own dev image for full toolchain fidelity.
FROM your-child-dev-image
# Claude Code + its libc shim. Alpine/musl base shown; on Debian/Ubuntu use apt-get.
RUN apk add --no-cache nodejs npm libc6-compat \
 && npm install -g @anthropic-ai/claude-code@2.1.210
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN adduser -u "$AGENT_UID" -D -h /home/agent agent
USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
DOCKER
    printf '.env\nlogs/\nworktrees/\npatches/\n' > "${sc}/.gitignore"
    printf 'CLAUDE_CODE_OAUTH_TOKEN=\n' > "${sc}/.env"
    say "· scaffolded ${sc}/{Dockerfile,.gitignore,.env}"
  fi
fi

# 3. Routing entry in the gitignored config/repos.json (additive; never clobber).
if [ "$DRY" = 1 ]; then
  say "  [dry] add config/repos.json entry: ${full} → { path: ${dir}, imageName: ${image}, promptFile: docs/sandbox-prompt.md, triggerLabels: [ready-for-agent, auto-dev] }"
else
  node -e '
    const fs = require("fs"), p = "config/repos.json";
    const t = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    const [key, dir, image] = process.argv.slice(1);
    if (t[key]) { console.log(`· config: ${key} already routed — leaving it`); process.exit(0); }
    t[key] = { path: dir, imageName: image, promptFile: "docs/sandbox-prompt.md", triggerLabels: ["ready-for-agent", "auto-dev"] };
    fs.writeFileSync(p, JSON.stringify(t, null, 2) + "\n");
    console.log(`· config: added ${key}`);
  ' "$full" "$dir" "$image"
fi

# 4. Seed the pipeline labels on the child's tracker (idempotent — ignore "exists").
for label in ready-for-agent auto-dev agent-working awaiting-human agent-failed; do
  if [ "$DRY" = 1 ]; then
    say "  [dry] gh label create ${label} --repo ${full}"
  else
    gh label create "$label" --repo "$full" >/dev/null 2>&1 && say "· label +${label}" || say "· label ${label} (exists / skipped)"
  fi
done

# 5. Regenerate the editor workspace so the new child gets its own root.
run "bash scripts/gen-workspace.sh"

cat <<NEXT

Next steps (child-specific — your judgement):
  1. Edit ${sc}/Dockerfile — base it on ${name}'s own dev image (see the onboarding recipe).
  2. Build the sandbox image:
       docker build --provenance=false -t ${image} \\
         --build-arg AGENT_UID=\$(id -u) --build-arg AGENT_GID=\$(id -g) ${sc}
  3. If ${name}'s tests need a service (DB, etc.), wire a per-run sidecar (see the recipe).
  4. Label an issue ready-for-agent + auto-dev to drive the first run.
NEXT
