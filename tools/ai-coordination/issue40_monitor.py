#!/usr/bin/env python3
"""Read-only Issue #40 REQUEST/ACK/RESPONSE monitor; never executes agent tasks."""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

REPO = os.environ.get("MONITOR_REPO", "rinatikd/nss-engine")
ISSUE = int(os.environ.get("MONITOR_ISSUE", "40"))
API = f"https://api.github.com/repos/{REPO}/issues/{ISSUE}/comments"
MARKER = re.compile(r"\[CODEX-CHAT (REQUEST|ACK|RESPONSE)\s+([a-zA-Z0-9_\-]+)\]")
AGENTS = ("codex", "qwen", "deepseek", "gemini", "grok", "claude")

def fetch_all():
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "issue40-readonly-monitor",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    results = []
    for page in range(1, 101):
        req = urllib.request.Request(f"{API}?per_page=100&page={page}", headers=headers)
        with urllib.request.urlopen(req, timeout=25) as response:
            batch = json.load(response)
        if not isinstance(batch, list):
            raise ValueError("GitHub API did not return a comment list")
        results.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise RuntimeError("pagination limit reached; results incomplete")
    return results

def analyze(comments):
    tasks = {}
    for item in comments:
        body = item.get("body") or ""
        for kind, task_id in MARKER.findall(body):
            # Match only the marker at the beginning of the comment, not embedded examples.
            if not body.lstrip().startswith(f"[CODEX-CHAT {kind} {task_id}]"):
                continue
            datum = {
                "comment_id": item["id"],
                "url": item.get("html_url"),
                "login": (item.get("user") or {}).get("login"),
                "created_at": item.get("created_at"),
            }
            entry = tasks.setdefault(task_id, {"requests": [], "ack": [], "response": []})
            entry[{"REQUEST":"requests","ACK":"ack","RESPONSE":"response"}[kind]].append(datum)
    output = []
    for task_id, record in sorted(tasks.items()):
        if not record["requests"]:
            continue
        # A coordinator-authored relay is not an authenticated agent ACK.
        ack = record["ack"]
        response = record["response"]
        status = "RESPONSE_RECORDED" if response else "ACK_RECORDED" if ack else "DELIVERY_UNCONFIRMED"
        output.append({"task_id": task_id, "status": status,
                       "request": record["requests"][-1], "ack": ack[-1] if ack else None,
                       "response": response[-1] if response else None,
                       "warning": "Comment authorship alone cannot authenticate an external AI agent."})
    return output

def main():
    try:
        rows = analyze(fetch_all())
    except (urllib.error.URLError, ValueError, RuntimeError) as exc:
        print(f"GitHub polling BLOCKED: {exc}", file=sys.stderr)
        return 2
    output = {"observed_at": datetime.now(timezone.utc).isoformat(),
              "source": API, "agent_side_polling_verified": False,
              "model_execution_triggered": False, "tasks": rows}
    os.makedirs("monitor-output", exist_ok=True)
    with open("monitor-output/status.json", "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    lines = ["# Issue #40 read-only delivery status", "",
             "This report detects GitHub comment markers only. It does **not** verify agent receipt, 5-minute agent polling, or model execution.", "",
             "| Task | Status | REQUEST | ACK | RESPONSE |",
             "|---|---|---|---|---|"]
    for row in rows:
        def link(d):
            return f"[comment]({d['url']})" if d and d.get("url") else "—"
        lines.append(f"| `{row['task_id']}` | {row['status']} | {link(row['request'])} | {link(row['ack'])} | {link(row['response'])} |")
    with open("monitor-output/status.md", "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
