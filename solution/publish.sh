#!/bin/sh
set -eu

solution_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_root=${APP_ROOT:-$(CDPATH= cd -- "$solution_dir/.." && pwd)}
if [ ! -f "$app_root/package.json" ] && [ -f "$app_root/environment/package.json" ]; then
	app_root="$app_root/environment"
fi
cd "$app_root"
publisher_path="$solution_dir/release-publisher.mjs"
if [ -f "$app_root/publisher/release-publisher.mjs" ]; then
	publisher_path="$app_root/publisher/release-publisher.mjs"
fi
exec node "$publisher_path" --report
