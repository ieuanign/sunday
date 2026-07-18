#!/usr/bin/env bash
# Regenerate `sunday.code-workspace` with each `repos/<child>` as its own editor root.
#
# Why: `repos/` is gitignored so Sunday never tracks your child repos — but that also makes
# editors grey out everything under `repos/`, hiding each child's own git status. A multi-root
# workspace gives each child its own root, so the editor decorates it using the CHILD's
# `.gitignore` instead of Sunday's.
#
# The GENERATED file is gitignored (it names your private children); THIS script is generic and
# committed. Re-run it after cloning a new child into `repos/`. (VS Code / Cursor / Windsurf.)
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

out="sunday.code-workspace"
folders='    { "name": "sunday (workspace)", "path": "." }'

if [ -d repos ]; then
  for d in repos/*/; do
    [ -d "$d" ] || continue                      # skip if repos/ is empty
    name="$(basename "$d")"
    folders="${folders},
    { \"name\": \"${name}\", \"path\": \"repos/${name}\" }"
  done
fi

cat > "$out" <<EOF
{
  "folders": [
${folders}
  ],
  "settings": {
    "files.exclude": { "repos": true },
    "git.autoRepositoryDetection": true,
    "git.openRepositoryInParentFolders": "never"
  }
}
EOF

echo "Wrote $out ($(grep -c '"path"' "$out") root(s)). Open it in your editor."
