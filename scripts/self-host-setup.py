#!/usr/bin/env python3
"""Entry point that also works with isolated Python during the sudo handoff."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from self_host.cli import main

if __name__ == '__main__':
    raise SystemExit(main(release=Path(__file__).resolve().parent.parent))
