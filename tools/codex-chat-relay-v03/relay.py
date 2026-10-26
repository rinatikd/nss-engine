"""Fail-closed Chat Relay skeleton. No model or tool execution is implemented."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

REPO = "rinatikd/nss-engine"
ISSUE = 40
SENDER_LOGIN = "rinatikd"
SENDER_ID = 337319789
MAX_BODY = 12_000
MAX_COMMENTS = 2_000
MAX_PAGES = 25
PAGE_TIMEOUT_SECONDS = 10
REQUEST = re.compile(r"\A\[CODEX-CHAT REQUEST ([A-Za-z0-9_-]{4,80})\]\r?\n([\s\S]{1,12000})\Z")
SECRET = re.compile(r"(?i)(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16})")
CODEX_LAUNCH_GATE_OPEN = False


class RelayError(Exception):
    """Safe, user-presentable failure with no raw subprocess output."""


@dataclass(frozen=True)
class Request:
    comment_id: int
    request_id: str
    body: str
    fingerprint: str
    created_at: str
    updated_at: str


def parse_request(comment: dict) -> Request | None:
    user, body = comment.get("user") or {}, comment.get("body")
    if user.get("login") != SENDER_LOGIN or user.get("id") != SENDER_ID:
        return None
    if not isinstance(body, str) or len(body.encode("utf-8")) > MAX_BODY:
        return None
    match = REQUEST.fullmatch(body.strip())
    if not match or SECRET.search(match.group(2)):
        return None
    cid = comment.get("id")
    created, updated = comment.get("created_at"), comment.get("updated_at")
    if not isinstance(cid, int) or cid <= 0 or not isinstance(created, str) or not isinstance(updated, str):
        return None
    if created != updated:  # edited issue comments are never executable requests
        return None
    return Request(cid, match.group(1), match.group(2), hashlib.sha256(body.encode("utf-8")).hexdigest(), created, updated)


class State:
    """SQLite dedup journal. Interrupted work becomes terminal UNKNOWN."""
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=5)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS requests (comment_id INTEGER PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL)")
        self.db.execute("UPDATE requests SET state='UNKNOWN',updated=? WHERE state IN ('RUNNING','PUBLISHING')", (int(time.time()),))
        self.db.commit()

    def claim(self, request: Request) -> bool:
        try:
            with self.db:
                self.db.execute("INSERT INTO requests VALUES (?,?,?,?,?)", (request.comment_id, request.request_id, request.fingerprint, "SEEN", int(time.time())))
            return True
        except sqlite3.IntegrityError:
            return False

    def state(self, request_id: str, value: str) -> None:
        with self.db:
            cur = self.db.execute("UPDATE requests SET state=?,updated=? WHERE request_id=? AND state NOT IN ('UNKNOWN','DONE')", (value, int(time.time()), request_id))
            if cur.rowcount != 1:
                raise RelayError("request state is terminal or missing")

    def close(self) -> None:
        self.db.close()


def launch_codex(*_args, **_kwargs):
    """Permanent v0.3 gate: no command can open the host execution path."""
    raise RelayError("BLOCKED: host sandbox smoke test and effective tool isolation are not attested")


class GitHub:
    """Read-only GitHub comment reader. Page adapter must honor its timeout; no retry."""
    def __init__(self, fetch_page: Callable[[int, int], tuple[int, list[dict], bool]], *, latency_seconds=15):
        self.fetch_page = fetch_page
        self.latency_seconds = latency_seconds

    def comments(self) -> list[dict]:
        start = time.monotonic()
        result, ids = [], set()
        for page in range(1, MAX_PAGES + 1):
            if time.monotonic() - start > self.latency_seconds:
                raise RelayError("GitHub pagination exceeded latency limit")
            try:
                status, rows, has_next = self.fetch_page(page, 100, timeout=min(PAGE_TIMEOUT_SECONDS, max(0.1, self.latency_seconds - (time.monotonic() - start))))
            except Exception as exc:
                raise RelayError("GitHub page request failed; no automatic retry") from exc
            if status != 200 or not isinstance(rows, list) or len(rows) > 100:
                raise RelayError("GitHub returned an invalid or partial page")
            if has_next and len(rows) != 100:
                raise RelayError("GitHub pagination gap detected")
            if len(result) + len(rows) > MAX_COMMENTS:
                raise RelayError("GitHub comment limit exceeded")
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("id"), int) or row["id"] in ids:
                    raise RelayError("GitHub page contains malformed or duplicate comments")
                ids.add(row["id"])
            result.extend(rows)
            if not has_next:
                if len(rows) == 100:
                    # A full page without a next link is ambiguous; require an empty terminal page.
                    continue
                return result
        raise RelayError("GitHub pagination page limit exceeded")


def revalidate_before_action(original: Request, fetch_current: Callable[[], dict], action: Callable[[], object]):
    """Re-fetch and compare the immutable request immediately before callback."""
    try:
        current = parse_request(fetch_current())
    except Exception as exc:
        raise RelayError("request revalidation failed; action blocked") from exc
    if current != original:
        raise RelayError("request changed or disappeared; action blocked")
    return action()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Chat Relay v0.3 source diagnostics only")
    parser.add_argument("--local-codex", action="store_true", help="always blocked; retained to make the gate explicit")
    parser.add_argument("--smoke-test", action="store_true", help="synthetic host test plan only; execution is blocked")
    args = parser.parse_args(argv)
    if args.local_codex or args.smoke_test or not CODEX_LAUNCH_GATE_OPEN:
        print("BLOCKED: Relay does not launch Codex in v0.3. No request was read, claimed, or executed.")
        return 3
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
