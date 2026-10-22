#!/usr/bin/env python
"""Export the FastAPI OpenAPI schema to `docs/openapi.json`.

Why this script exists
----------------------
The "API 文档 (OpenAPI)" deliverable needs the schema checked into the repo so
a reader can read the API surface without starting a server. FastAPI already
serves it live at `GET /openapi.json` and renders it at `GET /docs`, but that
only helps someone who has the backend running. This script makes the snapshot
reproducible: run it after any endpoint change and commit the diff.

Usage (from `TraffSim3D-backend/`)::

    .\\.venv\\Scripts\\python.exe scripts\\export_openapi.py
    .\\.venv\\Scripts\\python.exe scripts\\export_openapi.py --check
    .\\.venv\\Scripts\\python.exe scripts\\export_openapi.py --out D:\\tmp\\o.json

Notes
-----
- `sys.path` is patched to the backend root so the script works when invoked
  from any cwd (including via an absolute path from the repo root).
- Output is UTF-8 **without BOM**, 2-space indent, non-ASCII characters kept
  verbatim (`ensure_ascii=False`) so any Chinese `description` survives.
- A trailing newline is written so the file is well-behaved under git.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# scripts/export_openapi.py → parents[1] == TraffSim3D-backend/
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Default target: <repo root>/docs/openapi.json
DEFAULT_OUT = BACKEND_ROOT.parent / "docs" / "openapi.json"


def build_schema() -> dict:
    """Import the ASGI app and return its OpenAPI schema as a dict."""
    from app.main import app

    return app.openapi()


def render(schema: dict, indent: int) -> str:
    """Serialise the schema exactly as it is written to disk."""
    return json.dumps(schema, indent=indent, ensure_ascii=False, sort_keys=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Export app.main:app's OpenAPI schema to docs/openapi.json.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"Output path (default: {DEFAULT_OUT}).",
    )
    parser.add_argument(
        "--indent",
        type=int,
        default=2,
        help="JSON indent width (default: 2).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "Do not write; exit 1 if the file on disk differs from the "
            "freshly generated schema (drift check for CI)."
        ),
    )
    args = parser.parse_args(argv)

    schema = build_schema()
    text = render(schema, args.indent)

    if args.check:
        out: Path = args.out
        if not out.exists():
            print(f"[openapi] MISSING {out}", file=sys.stderr)
            return 1
        if out.read_text(encoding="utf-8") != text:
            print(
                f"[openapi] DRIFT {out} differs from the current app schema. "
                f"Re-run without --check and commit the result.",
                file=sys.stderr,
            )
            return 1
        print(f"[openapi] OK {out} is up to date.")
        return 0

    out = args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    # utf-8 without BOM — PowerShell's `-Encoding utf8` would add one, which
    # breaks strict JSON parsers and creates spurious diffs.
    out.write_text(text, encoding="utf-8", newline="\n")

    path_count = len(schema.get("paths", {}))
    op_count = sum(
        1
        for methods in schema.get("paths", {}).values()
        for method in methods
        if method.lower() in {"get", "post", "put", "patch", "delete", "head", "options"}
    )
    print(f"[openapi] wrote {out} ({out.stat().st_size} bytes)")
    print(f"[openapi] title={schema['info']['title']} version={schema['info']['version']}")
    print(f"[openapi] {path_count} paths / {op_count} operations")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
