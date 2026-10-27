#!/usr/bin/env python3
"""Read-only, allowlisted GitHub inbox. Issue text is stored only as a hash."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol


OWNER = "rinatikd"
REPO = "nss-engine"
ALLOWED_ISSUES = (54, 57)
ALLOWED_AUTHOR_LOGIN = "rinatikd"
ALLOWED_AUTHOR_ID = 337319789
API_ROOT = "https://api.github.com/repos/rinatikd/nss-engine/issues"
PAGE_SIZE = 100
MAX_PAGES = 100
MAX_BODY_BYTES = 1_000_000
USER_AGENT = "nss-engine-readonly-inbox-0057a/1.0"
MARKER_RE = re.compile(r"\[(CODEX-CHANNEL|CODEX-CHAT|COORDINATOR) ([A-Z][A-Z_-]*)(?: ([A-Za-z0-9_.-]{1,100}))?\]")


class InboxError(RuntimeError):
    pass


class CommentSource(Protocol):
    def fetch_all(self, issue_number: int) -> list[dict[str, object]]: ...


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: object
    body: bytes


class GitHubPublicApi:
    """Unauthenticated GitHub REST reader, restricted to two fixed issue URLs."""

    def __init__(self, opener=None, sleep=time.sleep, retry_limit: int = 2):
        self._opener = opener or urllib.request.urlopen
        self._sleep = sleep
        self._retry_limit = retry_limit

    def _get_json(self, url: str) -> object:
        for attempt in range(self._retry_limit + 1):
            request = urllib.request.Request(
                url,
                headers={"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT,
                         "X-GitHub-Api-Version": "2022-11-28"},
                method="GET",
            )
            try:
                response = self._opener(request, timeout=15)
                status = getattr(response, "status", 200)
                headers = getattr(response, "headers", {})
                body = response.read(MAX_BODY_BYTES + 1)
                close = getattr(response, "close", None)
                if close:
                    close()
            except urllib.error.HTTPError as exc:
                status, headers = exc.code, exc.headers or {}
                body = exc.read(MAX_BODY_BYTES + 1)
                exc.close()
            except (TimeoutError, OSError, urllib.error.URLError) as exc:
                raise InboxError(f"GitHub request failed ({type(exc).__name__}); no cursor update") from None

            if len(body) > MAX_BODY_BYTES:
                raise InboxError("GitHub response exceeded size limit; no cursor update")
            if status == 200:
                try:
                    return json.loads(body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    raise InboxError("GitHub returned invalid UTF-8 JSON; no cursor update") from None
            if status == 401:
                raise InboxError("GitHub returned 401; public read access unavailable; no cursor update")
            if status == 403 or status == 429:
                retry_after = _header(headers, "Retry-After")
                remaining = _header(headers, "X-RateLimit-Remaining")
                reset = _header(headers, "X-RateLimit-Reset")
                is_rate_limit = status == 429 or remaining == "0" or bool(retry_after)
                if is_rate_limit and attempt < self._retry_limit:
                    delay = _bounded_retry_delay(retry_after, reset, attempt)
                    self._sleep(delay)
                    continue
                label = "rate limit" if is_rate_limit else "permission denied"
                raise InboxError(f"GitHub returned {status} ({label}); no cursor update")
            if status >= 500 and attempt < self._retry_limit:
                self._sleep(min(2 ** attempt, 4))
                continue
            raise InboxError(f"GitHub returned HTTP {status}; no cursor update")
        raise InboxError("GitHub retry limit reached; no cursor update")

    def fetch_all(self, issue_number: int) -> list[dict[str, object]]:
        if issue_number not in ALLOWED_ISSUES:
            raise InboxError("issue is not allowlisted")
        all_comments: list[dict[str, object]] = []
        seen: set[int] = set()
        for page in range(1, MAX_PAGES + 1):
            query = urllib.parse.urlencode({"per_page": PAGE_SIZE, "page": page})
            payload = self._get_json(f"{API_ROOT}/{issue_number}/comments?{query}")
            if not isinstance(payload, list):
                raise InboxError(f"issue {issue_number} page {page} was not a list; no cursor update")
            if len(payload) > PAGE_SIZE:
                raise InboxError(f"issue {issue_number} page {page} exceeded page size; no cursor update")
            for raw in payload:
                comment = _validate_comment(raw, issue_number)
                if comment["id"] in seen:
                    raise InboxError(f"duplicate comment ID in issue {issue_number}; no cursor update")
                seen.add(int(comment["id"]))
                all_comments.append(comment)
            if len(payload) < PAGE_SIZE:
                return all_comments
        raise InboxError(f"issue {issue_number} exceeded pagination safety limit; no cursor update")


def _header(headers: object, name: str) -> str | None:
    if hasattr(headers, "get"):
        value = headers.get(name)
        if value is None:
            value = headers.get(name.lower())
        return str(value) if value is not None else None
    return None


def _bounded_retry_delay(retry_after: str | None, reset: str | None, attempt: int) -> float:
    if retry_after:
        try:
            return min(max(float(retry_after), 0), 10)
        except ValueError:
            pass
    if reset:
        try:
            return min(max(float(reset) - time.time(), 0), 10)
        except ValueError:
            pass
    return float(min(2 ** attempt, 4))


def _validate_comment(raw: object, issue_number: int) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise InboxError(f"malformed comment in issue {issue_number}; no cursor update")
    try:
        comment_id = int(raw["id"])
        issue_url = raw["issue_url"]
        author = raw["user"]
        login = author["login"]
        author_id = int(author["id"])
        created_at = raw["created_at"]
        updated_at = raw["updated_at"]
        html_url = raw["html_url"]
        body = raw.get("body") or ""
    except (KeyError, TypeError, ValueError):
        raise InboxError(f"incomplete comment metadata in issue {issue_number}; no cursor update") from None
    expected_issue_url = f"https://api.github.com/repos/{OWNER}/{REPO}/issues/{issue_number}"
    expected_comment_prefix = f"https://github.com/{OWNER}/{REPO}/issues/{issue_number}#issuecomment-"
    if comment_id <= 0 or issue_url != expected_issue_url or not isinstance(login, str):
        raise InboxError(f"comment identity mismatch in issue {issue_number}; no cursor update")
    if not isinstance(created_at, str) or not isinstance(updated_at, str) or not isinstance(html_url, str):
        raise InboxError(f"invalid comment timestamps or URL in issue {issue_number}; no cursor update")
    if not html_url.startswith(expected_comment_prefix) or not html_url.endswith(str(comment_id)):
        raise InboxError(f"comment URL mismatch in issue {issue_number}; no cursor update")
    if not isinstance(body, str):
        raise InboxError(f"comment body invalid or oversized in issue {issue_number}; no cursor update")
    try:
        body_bytes = body.encode("utf-8")
    except UnicodeEncodeError:
        raise InboxError(f"comment body is not valid Unicode in issue {issue_number}; no cursor update") from None
    if len(body_bytes) > MAX_BODY_BYTES:
        raise InboxError(f"comment body invalid or oversized in issue {issue_number}; no cursor update")
    for stamp in (created_at, updated_at):
        try:
            datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            raise InboxError(f"invalid comment timestamp in issue {issue_number}; no cursor update") from None
    trusted = login.casefold() == ALLOWED_AUTHOR_LOGIN.casefold() and author_id == ALLOWED_AUTHOR_ID
    marker_match = MARKER_RE.search(body)
    marker = " ".join(x for x in marker_match.groups() if x) if marker_match else ""
    return {
        "id": comment_id, "issue": issue_number, "author_login": login,
        "author_id": author_id, "created_at": created_at, "updated_at": updated_at,
        "html_url": html_url, "body_sha256": hashlib.sha256(body_bytes).hexdigest(),
        "marker": marker[:160], "trusted": trusted,
    }


def default_db_path() -> Path:
    root = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_STATE_HOME")
    if root:
        base = Path(root)
    else:
        base = Path.home() / ".local" / "state"
    return base / "NSSCodexInbox0057A" / "inbox.sqlite3"


def _connect(db_path: Path) -> sqlite3.Connection:
    absolute = Path(os.path.abspath(db_path))
    _reject_reparse_path(absolute)
    absolute.parent.mkdir(parents=True, exist_ok=True)
    _reject_reparse_path(absolute)
    for sidecar in (Path(str(absolute) + "-wal"), Path(str(absolute) + "-shm")):
        _reject_reparse_path(sidecar)
    connection = sqlite3.connect(absolute, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=10000")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS comments (
          issue_no INTEGER NOT NULL, comment_id INTEGER NOT NULL,
          author_login TEXT NOT NULL, author_id INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          html_url TEXT NOT NULL, body_sha256 TEXT NOT NULL, marker TEXT NOT NULL,
          trust_status TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(issue_no, comment_id));
        CREATE TABLE IF NOT EXISTS audit (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
          issue_no INTEGER NOT NULL, comment_id INTEGER, event_at TEXT NOT NULL,
          status TEXT NOT NULL, marker TEXT NOT NULL, details TEXT NOT NULL DEFAULT '');
        CREATE UNIQUE INDEX IF NOT EXISTS audit_dedup
          ON audit(event_type, issue_no, comment_id, status, marker);
    """)
    return connection


def _reject_reparse_path(path: Path) -> None:
    """Best-effort refusal for existing symlink/junction components; not a TOCTOU sandbox."""
    candidates = (path, *path.parents)
    for candidate in candidates:
        try:
            is_junction = getattr(candidate, "is_junction", lambda: False)()
            if candidate.is_symlink() or is_junction:
                raise InboxError("database path contains a symlink/junction; no cursor update")
        except OSError:
            raise InboxError("database path could not be inspected; no cursor update") from None


def scan_once(db_path: Path, source: CommentSource) -> dict[str, object]:
    # Fetch every page for every allowed issue before opening a write transaction.
    snapshot: dict[int, list[dict[str, object]]] = {}
    for issue_number in ALLOWED_ISSUES:
        snapshot[issue_number] = source.fetch_all(issue_number)
    scan_time = datetime.now(timezone.utc).isoformat(timespec="seconds")
    connection = _connect(db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        baseline = connection.execute("SELECT value FROM meta WHERE key='baseline_complete'").fetchone()
        first_scan = baseline is None
        emitted: list[dict[str, object]] = []
        for issue_number, comments in snapshot.items():
            current_ids: set[int] = set()
            max_id = 0
            for comment in comments:
                comment_id = int(comment["id"])
                max_id = max(max_id, comment_id)
                current_ids.add(comment_id)
                existing = connection.execute(
                    "SELECT * FROM comments WHERE issue_no=? AND comment_id=?",
                    (issue_number, comment_id),
                ).fetchone()
                trusted = bool(comment["trusted"])
                trust_status = "ALLOWLISTED_AUTHOR" if trusted else "UNTRUSTED_AUTHOR"
                if existing is None:
                    state = "BASELINE" if first_scan else ("OBSERVED_UNVERIFIED" if trusted else "UNTRUSTED_IGNORED")
                    connection.execute("""INSERT INTO comments
                        (issue_no,comment_id,author_login,author_id,created_at,updated_at,html_url,
                         body_sha256,marker,trust_status,deleted)
                         VALUES (?,?,?,?,?,?,?,?,?,?,0)""",
                        (issue_number, comment_id, comment["author_login"], comment["author_id"],
                         comment["created_at"], comment["updated_at"], comment["html_url"],
                         comment["body_sha256"], comment["marker"], trust_status))
                    if not first_scan:
                        event_type = "COMMENT_OBSERVED" if trusted else "UNTRUSTED_COMMENT_IGNORED"
                        connection.execute("""INSERT OR IGNORE INTO audit
                            (event_type,issue_no,comment_id,event_at,status,marker)
                            VALUES (?,?,?,?,?,?)""",
                            (event_type, issue_number, comment_id, scan_time, state, comment["marker"]))
                        if trusted:
                            event = connection.execute("""SELECT event_id FROM audit WHERE event_type=?
                                AND issue_no=? AND comment_id=? AND status=? AND marker=?""",
                                (event_type, issue_number, comment_id, state, comment["marker"])).fetchone()
                            emitted.append({"issue": issue_number, "comment_id": comment_id,
                                            "status": "OBSERVED_UNVERIFIED", "marker": comment["marker"],
                                            "audit_event_id": int(event["event_id"]) if event else None,
                                            "url": comment["html_url"]})
                    continue
                changed = (existing["body_sha256"] != comment["body_sha256"] or
                           existing["author_login"] != comment["author_login"] or
                           existing["author_id"] != comment["author_id"] or
                           existing["updated_at"] != comment["updated_at"])
                if changed:
                    event_type = "COMMENT_EDITED"
                    state = "EDITED_UNTRUSTED"
                    connection.execute("""INSERT OR IGNORE INTO audit
                        (event_type,issue_no,comment_id,event_at,status,marker)
                        VALUES (?,?,?,?,?,?)""",
                        (event_type, issue_number, comment_id, scan_time, state, ""))
                elif existing["deleted"]:
                    connection.execute("""INSERT OR IGNORE INTO audit
                        (event_type,issue_no,comment_id,event_at,status,marker)
                        VALUES (?,?,?,?,?,?)""",
                        ("COMMENT_REAPPEARED", issue_number, comment_id, scan_time, "REAPPEARED_UNVERIFIED", ""))
                connection.execute("""UPDATE comments SET author_login=?,author_id=?,created_at=?,updated_at=?,
                    html_url=?,body_sha256=?,marker=?,trust_status=?,deleted=0
                    WHERE issue_no=? AND comment_id=?""",
                    (comment["author_login"], comment["author_id"], comment["created_at"],
                     comment["updated_at"], comment["html_url"], comment["body_sha256"],
                     comment["marker"], trust_status, issue_number, comment_id))
            known_rows = connection.execute("SELECT comment_id FROM comments WHERE issue_no=? AND deleted=0",
                                            (issue_number,)).fetchall()
            for row in known_rows:
                comment_id = int(row["comment_id"])
                if comment_id not in current_ids:
                    connection.execute("UPDATE comments SET deleted=1 WHERE issue_no=? AND comment_id=?",
                                       (issue_number, comment_id))
                    connection.execute("""INSERT OR IGNORE INTO audit
                        (event_type,issue_no,comment_id,event_at,status,marker)
                        VALUES (?,?,?,?,?,?)""",
                        ("COMMENT_DELETED", issue_number, comment_id, scan_time, "DELETED_DETECTED", ""))
            prior = connection.execute("SELECT value FROM meta WHERE key=?",
                                       (f"cursor_issue_{issue_number}",)).fetchone()
            monotonic_id = max(max_id, int(prior["value"]) if prior else 0)
            connection.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                               (f"cursor_issue_{issue_number}", str(monotonic_id)))
        connection.execute("INSERT INTO meta(key,value) VALUES('baseline_complete','1') ON CONFLICT(key) DO UPDATE SET value='1'")
        connection.execute("INSERT INTO meta(key,value) VALUES('last_complete_scan',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                           (scan_time,))
        connection.commit()
        return {"status": "BASELINE_ESTABLISHED" if first_scan else "SCAN_COMPLETE",
                "observed": emitted, "issues": list(ALLOWED_ISSUES), "scan_at": scan_time}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def status(db_path: Path) -> dict[str, object]:
    if not db_path.exists():
        return {"status": "NOT_INITIALIZED", "database": str(db_path), "baseline_complete": False,
                "poller_running": False}
    connection = _connect(db_path)
    try:
        meta = {row["key"]: row["value"] for row in connection.execute("SELECT key,value FROM meta")}
        cursors = {str(issue): meta.get(f"cursor_issue_{issue}") for issue in ALLOWED_ISSUES}
        events = [dict(row) for row in connection.execute(
            "SELECT event_id,event_type,issue_no,comment_id,event_at,status,marker FROM audit ORDER BY event_id DESC LIMIT 20")]
        return {"status": "READY" if meta.get("baseline_complete") == "1" else "NOT_INITIALIZED",
                "database": str(db_path), "baseline_complete": meta.get("baseline_complete") == "1",
                "last_complete_scan": meta.get("last_complete_scan"), "cursors": cursors,
                "recent_events": events, "poller_running": False}
    finally:
        connection.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only GitHub task inbox; never launches Codex.")
    parser.add_argument("command", choices=("status", "scan-once"))
    parser.add_argument("--db", type=Path, default=default_db_path())
    args = parser.parse_args(argv)
    if args.command == "status":
        print(json.dumps(status(args.db), ensure_ascii=False, indent=2))
        return 0
    try:
        result = scan_once(args.db, GitHubPublicApi())
    except InboxError as exc:
        print(json.dumps({"status": "SCAN_BLOCKED", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except (OSError, sqlite3.Error) as exc:
        print(json.dumps({"status": "SCAN_BLOCKED", "error": type(exc).__name__}, ensure_ascii=False), file=sys.stderr)
        return 2
    except Exception as exc:
        print(json.dumps({"status": "SCAN_BLOCKED", "error": f"unexpected {type(exc).__name__}"}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
