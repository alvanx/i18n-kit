#!/usr/bin/env bash
# Resolve the i18n-kit CLI and run it, wherever the toolkit happens to live.
#
# The point of this wrapper is that nobody has to remember a path. It is the
# only entry point the localize skill uses, and it works on a machine that has
# never seen the toolkit before.
set -euo pipefail

KIT=""
# Always succeeds, so a miss cannot trip `set -e` at a call site, and the first
# candidate that matches wins.
have() {
  [ -z "$KIT" ] && [ -n "${1:-}" ] && [ -f "$1/packages/core/bin/i18n.mjs" ] && KIT="$1"
  return 0
}

# 1. An explicit override wins, for a checkout somewhere unusual.
have "${I18N_KIT_HOME:-}"

# 2. Installed into the project being worked on, which is the right answer once
#    this is on npm: the project then pins the version it was tested against.
if [ -z "$KIT" ] && [ -x "./node_modules/.bin/i18n" ]; then
  exec ./node_modules/.bin/i18n "$@"
fi

# 3. The copy this skill ships inside, three directories up from this script.
#    `pwd -P` resolves every symlink in the path, so it finds the repo whether
#    the skill was copied into ~/.claude/skills or symlinked there.
SELFDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)"
have "${SELFDIR%/*/*/*}"

# 4. The usual working copy on this machine.
have "$HOME/Coding Projects/i18n-kit"

# 5. A cached clone, fetched once on first use. This is what makes the skill
#    work on a machine that has never seen the toolkit.
CACHE="$HOME/.cache/i18n-kit"
if [ -z "$KIT" ]; then
  if [ ! -d "$CACHE/.git" ]; then
    echo "i18n-kit: fetching the toolkit into $CACHE (first run only)" >&2
    git clone --quiet --depth 1 https://github.com/alvanx/i18n-kit.git "$CACHE" >&2
  fi
  have "$CACHE"
fi

if [ -z "$KIT" ]; then
  cat >&2 <<'MSG'
i18n-kit: could not find the toolkit.

Either clone it:
  git clone https://github.com/alvanx/i18n-kit.git ~/.cache/i18n-kit
or point at an existing checkout:
  export I18N_KIT_HOME=/path/to/i18n-kit
MSG
  exit 1
fi

# The ICU parser is a real dependency, so a fresh checkout needs its modules.
if [ ! -d "$KIT/node_modules/@formatjs" ]; then
  echo "i18n-kit: installing dependencies in $KIT (first run only)" >&2
  (cd "$KIT" && npm install --silent) >&2
fi

# Run from the caller's directory, so the CLI's default project root is right.
exec node "$KIT/packages/core/bin/i18n.mjs" "$@"
