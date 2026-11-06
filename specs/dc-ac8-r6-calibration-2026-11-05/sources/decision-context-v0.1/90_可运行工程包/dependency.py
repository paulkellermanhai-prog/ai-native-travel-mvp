"""Locate the fixed Trip State dependency in source or reader-package layouts."""
from pathlib import Path
import sys


def locate():
    sibling = Path(__file__).resolve().parents[2] / "trip-state-schema-v0.1"
    for candidate in (sibling, sibling / "90_可运行工程包"):
        if (candidate / "tripstate" / "engine.py").is_file():
            return candidate
    raise RuntimeError("缺少相邻 Trip State 0.1.0 工程包；不能用其他状态实现代替")


BASE = locate()
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))
