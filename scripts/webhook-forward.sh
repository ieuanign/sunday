#!/usr/bin/env bash
# webhook-forward.sh — supervised (process-compose) launcher for the GitHub event
# relay. Reads the gitignored routing table `config/repos.json` and forwards each
# repo's events to the local listener. Kept generic so no child repo name lands in
# a tracked file (publish policy); the child names live only in config/repos.json.
#
# Group-restart by design: forwards are stateless and idempotent (a missed event is
# recovered by the listener's reconcile), so if any one forward dies this exits and
# process-compose restarts the whole group — trivial and harmless. Portable shell
# (no `wait -n`) so it runs on stock macOS bash 3.2 as well as Linux.
set -eu

port="${LISTENER_PORT:-8787}"
pids=""

cleanup() {
  for p in $pids; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 0' INT TERM

# One forwarder per repo (the routing table's top-level keys are "owner/repo").
while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  gh webhook forward --repo "$repo" \
    --events issues,issue_comment,pull_request,pull_request_review_comment \
    --url "http://localhost:${port}/" &
  pids="$pids $!"
done <<EOF
$(jq -r 'keys[]' config/repos.json)
EOF

if [ -z "${pids# }" ]; then
  echo "webhook-forward: no repos in config/repos.json — nothing to forward"
  exit 0
fi
echo "webhook-forward: forwarding for$(echo "$pids" | wc -w | tr -d ' ') repo(s) → http://localhost:${port}/"

# Exit as soon as ANY forwarder dies, so process-compose cycles the group.
while true; do
  for p in $pids; do
    kill -0 "$p" 2>/dev/null || { echo "webhook-forward: a forwarder ($p) exited — cycling group"; exit 1; }
  done
  sleep 5
done
