"""Plan 041: FastAPI /api/v1/maps/parse-osm smoke tests.

Strategy: launch uvicorn in a subprocess on a free port, hit it via
urllib (stdlib), tear down. Slow but zero-dep, no TestClient issues.
For real CI, plan 044 will swap to a proper ASGI in-process client.
"""
from __future__ import annotations

import json
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures" / "sample-4way.osm"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextmanager
def _uvicorn_server():
    port = _free_port()
    proc = subprocess.Popen(
        [
            "uv", "run", "uvicorn", "app.main:app",
            "--port", str(port), "--log-level", "warning",
        ],
        cwd=Path(__file__).parent.parent,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"{base}/health", timeout=0.5).read()
            break
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.2)
    else:
        proc.terminate()
        raise RuntimeError("uvicorn did not start within 10s")
    try:
        yield base
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def _post_file(url: str, path: Path) -> tuple[int, str]:
    boundary = "----t3stb0undary"
    body_bytes = path.read_bytes()
    parts = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: application/xml\r\n\r\n"
    ).encode() + body_bytes + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        url, data=parts, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def test_parse_osm_returns_200_with_roads() -> None:
    with _uvicorn_server() as base:
        status, body = _post_file(f"{base}/api/v1/maps/parse-osm", FIXTURE)
    assert status == 200, f"got {status}: {body[:200]}"
    parsed = json.loads(body)
    assert "roads" in parsed
    assert len(parsed["roads"]) >= 2


def test_parse_osm_rejects_invalid_xml() -> None:
    with tempfile.NamedTemporaryFile(suffix=".osm", delete=False) as tf:
        tf.write(b"<not-xml")  # unclosed tag — truly invalid
        tmp = Path(tf.name)
    try:
        with _uvicorn_server() as base:
            status, body = _post_file(f"{base}/api/v1/maps/parse-osm", tmp)
    finally:
        tmp.unlink()
    assert status == 400
    assert "Invalid OSM XML" in body