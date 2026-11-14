#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  print '未找到 Python 3，请安装 Python 3 后再启动。'
  read '?按回车关闭…'
  exit 1
fi
python3 scripts/serve-prototype.py "$@" || {
  read '?启动失败，按回车关闭…'
  exit 1
}
