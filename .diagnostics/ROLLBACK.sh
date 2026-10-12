#!/bin/sh
set -eu
TARGET=${1:?usage: ROLLBACK.sh TARGET_COPY}
BASELINE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(basename -- "$TARGET")" in
  MODIFIED_FILE|index.html|*.html) BASELINE="$BASELINE_DIR/index.html.baseline" ;;
  MODIFIED_FILE.user.js|cloud-game-click-automation.user.js|*.user.js) BASELINE="$BASELINE_DIR/cloud-game-click-automation.user.js.baseline" ;;
  *) echo "unsupported target: $TARGET" >&2; exit 2 ;;
esac
cp "$BASELINE" "$TARGET"
sha256sum "$TARGET"
