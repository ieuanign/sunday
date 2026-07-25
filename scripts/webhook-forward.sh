#!/usr/bin/env bash
# webhook-forward.sh — supervised (process-compose) launcher for the GitHub event
# relay. Reads the gitignored routing table `config/repos.json` and forwards each
# repo's events to the local listener. Kept generic so no child repo name lands in
# a tracked file (publish policy); the child names live only in config/repos.json.
#
# Self-healing per repo: `gh webhook forward` EXITS when its websocket drops
# (`close 1006 (abnormal closure): unexpected EOF` — routine), so the poll loop
# respawns that one forwarder and leaves the others alone. Recovery is deliberately
# NOT delegated upward: on 2026-07-24 one dropped forwarder took the whole group
# down and process-compose did not restart it for 8h44m, blacking out every repo's
# events (the listener re-derives missed work only on boot, so nothing recovered).
# Respawning is cheap and idempotent — `gh` keeps one dev webhook per repo rather
# than accumulating them. Portable shell (no `wait -n`, no associative arrays) so
# it runs on stock macOS bash 3.2 as well as Linux.
set -eu

port="${LISTENER_PORT:-8787}"
events="issues,issue_comment,pull_request,pull_request_review_comment"

# One forwarder per repo (the routing table's top-level keys are "owner/repo").
repos=()
while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  repos+=("$repo")
done <<EOF
$(jq -r 'keys[]' config/repos.json)
EOF

if [ "${#repos[@]}" -eq 0 ]; then
  echo "webhook-forward: no repos in config/repos.json — nothing to forward"
  exit 0
fi

pids=()

# `gh webhook forward` registers one dev webhook per repo and removes it on a clean
# exit. A hard stop (SIGKILL, crash, power loss) strands it, and every later start
# then dies on `HTTP 422 … Hook already exists on this repository` — a blackout no
# amount of retrying clears. Drop a stranded forwarder hook before (re)starting so
# the relay always recovers unattended. Matched on gh's own forwarder URL, so a
# repo's real webhooks are never touched.
forwarder_hook_url="https://webhook-forwarder.github.com/hook"

drop_stale_hook() {
  gh api "repos/$1/hooks" --jq ".[] | select(.config.url == \"$forwarder_hook_url\") | .id" |
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      gh api -X DELETE "repos/$1/hooks/$id" >/dev/null || true
    done
}

# (Re)start the forwarder for repos[$1], recording its pid at the same index.
spawn() {
  drop_stale_hook "${repos[$1]}"
  gh webhook forward --repo "${repos[$1]}" --events "$events" \
    --url "http://localhost:${port}/" &
  pids[$1]=$!
}

cleanup() {
  # Guard the expansion: on bash 3.2 `"${arr[@]}"` on an empty array trips `set -u`.
  [ "${#pids[@]}" -gt 0 ] || return 0
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 0' INT TERM

i=0
while [ "$i" -lt "${#repos[@]}" ]; do
  spawn "$i"
  i=$((i + 1))
done
echo "webhook-forward: forwarding for ${#repos[@]} repo(s) → http://localhost:${port}/"

# Respawn any forwarder that has exited; never take the group down for one of them.
while true; do
  i=0
  while [ "$i" -lt "${#repos[@]}" ]; do
    if ! kill -0 "${pids[$i]}" 2>/dev/null; then
      wait "${pids[$i]}" 2>/dev/null || true # reap before replacing
      echo "webhook-forward: ${repos[$i]} forwarder exited — restarting"
      spawn "$i"
    fi
    i=$((i + 1))
  done
  sleep 5
done
