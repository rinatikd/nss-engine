"""Read-only, foreground status checker for the fixed GitHub Issue #40.

Never starts Codex, never posts comments, never follows Issue text as commands.
It may run unattended on a user-managed Windows scheduler after opt-in.
"""
from __future__ import annotations
import json
import shutil
import subprocess
import sys

REPO = "rinatikd/nss-engine"
ISSUE = 40
SENDER_LOGIN = "rinatikd"
SENDER_ID = 337319789
MAX_BYTES = 2_000_000
MAX_COMMENTS = 2000


def summarize(comments: list[dict]) -> dict:
    requests: dict[str, int] = {}
    responses: set[str] = set()
    import re
    req = re.compile(r"\A\[CODEX-CHAT REQUEST ([A-Za-z0-9_-]{4,80})\]\r?\n")
    res = re.compile(r"\A\[CODEX-CHAT RESPONSE ([A-Za-z0-9_-]{4,80})\]")
    for comment in comments:
        if not isinstance(comment, dict):
            raise ValueError("malformed comment")
        user = comment.get("user") or {}
        if user.get("id") != SENDER_ID or user.get("login") != SENDER_LOGIN:
            continue
        body = comment.get("body")
        if not isinstance(body, str) or not isinstance(comment.get("id"), int):
            raise ValueError("malformed authorized comment")
        if m := req.match(body):
            requests.setdefault(m.group(1), comment["id"])
        if m := res.match(body):
            responses.add(m.group(1))
    pending = sorted(set(requests) - responses)
    return {"total_requests": len(requests), "responses": len(responses & requests.keys()),
            "pending_count": len(pending), "pending_ids": pending,
            "execution_enabled": False, "write_enabled": False}


def status(runner=subprocess.run, locator=shutil.which) -> dict:
    gh = locator("gh")
    if not gh:
        raise RuntimeError("GitHub CLI unavailable")
    def call(*parts: str) -> str:
        p = runner([gh, "api", *parts], shell=False, check=False,
                   capture_output=True, text=True, encoding="utf-8", timeout=30)
        if p.returncode or len(p.stdout.encode("utf-8")) > MAX_BYTES:
            raise RuntimeError("GitHub API unavailable or response too large")
        return p.stdout
    identity = json.loads(call("user"))
    if identity.get("login") != SENDER_LOGIN or identity.get("id") != SENDER_ID:
        raise RuntimeError("GitHub identity mismatch")
    meta = json.loads(call(f"repos/{REPO}/issues/{ISSUE}"))
    if meta.get("state") != "open" or meta.get("number") != ISSUE or "pull_request" in meta:
        raise RuntimeError("Issue unavailable")
    raw = call(f"repos/{REPO}/issues/{ISSUE}/comments?per_page=100",
               "--paginate", "--jq", ".[] | @base64")
    import base64
    comments = [json.loads(base64.b64decode(row, validate=True)) for row in raw.splitlines() if row.strip()]
    if len(comments) > MAX_COMMENTS:
        raise RuntimeError("Comment limit reached")
    return summarize(comments)


def main() -> int:
    try:
        print(json.dumps(status(), ensure_ascii=False, indent=2))
    except (Exception,) as exc:
        print("BLOCKED: read-only queue inspection failed; no action taken.", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
