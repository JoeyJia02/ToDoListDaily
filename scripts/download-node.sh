#!/bin/sh
# Official, project-local runtime; no sudo / PATH / shell-profile modifications.
set -eu
PLANNER_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PLANNER_VERSION=v24.22.1
case "$(uname -m)" in arm64) PLANNER_ARCH=arm64;; x86_64) PLANNER_ARCH=x64;; *) echo '仅支持 macOS arm64/x64' >&2; exit 1;; esac
[ "$(uname -s)" = Darwin ] || { echo '仅支持 macOS' >&2; exit 1; }
PLANNER_ARCHIVE="node-$PLANNER_VERSION-darwin-$PLANNER_ARCH.tar.gz"
PLANNER_TMP=$(mktemp -d)
trap 'rm -rf "$PLANNER_TMP"' EXIT
echo "从 nodejs.org 下载 ${PLANNER_VERSION}，只安装到项目 .runtime/node"
curl -fL --max-time 180 "https://nodejs.org/dist/$PLANNER_VERSION/$PLANNER_ARCHIVE" -o "$PLANNER_TMP/$PLANNER_ARCHIVE"
curl -fL --max-time 60 "https://nodejs.org/dist/$PLANNER_VERSION/SHASUMS256.txt" -o "$PLANNER_TMP/SHASUMS256.txt"
PLANNER_HASH=$(awk -v file="$PLANNER_ARCHIVE" '$2 == file {print $1}' "$PLANNER_TMP/SHASUMS256.txt")
[ "${#PLANNER_HASH}" -eq 64 ] || { echo '缺少官方校验值' >&2; exit 1; }
(cd "$PLANNER_TMP" && printf '%s  %s\n' "$PLANNER_HASH" "$PLANNER_ARCHIVE" | shasum -a 256 -c -)
tar -xzf "$PLANNER_TMP/$PLANNER_ARCHIVE" -C "$PLANNER_TMP"
mkdir -p "$PLANNER_ROOT/.runtime"
[ ! -e "$PLANNER_ROOT/.runtime/node" ] || { echo '.runtime/node 已存在，未覆盖。' >&2; exit 1; }
mv "$PLANNER_TMP/node-$PLANNER_VERSION-darwin-$PLANNER_ARCH" "$PLANNER_ROOT/.runtime/node"
"$PLANNER_ROOT/.runtime/node/bin/node" --version
