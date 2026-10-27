"""v0.13 operator-gated pilot, no auto publication and no transparent retries.

A live call is attempted only after explicit operator opt-in and secret/budget
preflight. It always stages to the durable GitHub outbox; publishing requires
separate operator invocation of outbox.py. No unattended live scheduler.
"""
import argparse
import json
import os
import re
from pathlib import Path
from paid_policy import PAID_API_ALLOWED

from pilot import pilot

REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def preflight(env=None, live=False):
    e = os.environ if env is None else env
    checks = {
        "paid_api_policy": PAID_API_ALLOWED,
        "ledger_secret": len(e.get("AI_LEDGER_HMAC_KEY", "")) >= 32,
        "claude_key_present": len(e.get("ANTHROPIC_API_KEY", "")) >= 16,
        "github_token_present": len(e.get("GITHUB_TOKEN", "")) >= 16,
        "github_target": bool(REPO_RE.fullmatch(e.get("GITHUB_REPOSITORY", "")))
            and e.get("GITHUB_ISSUE_NUMBER", "").isdigit()
            and int(e.get("GITHUB_ISSUE_NUMBER", "0")) > 0,
        "model_approval": e.get("AI_APPROVE_REAL_REQUEST") == "YES_I_APPROVE_ONE_PAID_CLAUDE_REQUEST",
        "github_approval": e.get("AI_APPROVE_GITHUB_WRITE") == "YES_I_APPROVE_GITHUB_ISSUE_WRITE",
    }
    for key in ("AI_MAX_CALLS_PER_DAY", "AI_MAX_PLANNED_TOKENS_PER_DAY"):
        val=e.get(key, "")
        checks[key] = val.isdecimal() and int(val) > 0
    # The two operator approvals are separate from the API tokens themselves.
    return {"ready": all(checks.values()), "checks": checks,
            "live": bool(live), "requests_sent": 0,
            "warning": "Presence/format only. API credentials, permissions and spending are not verified."}


def run_pilot(db, task_id, prompt, live=False, env=None):
    e=os.environ if env is None else env
    if live:
        report=preflight(e, live=True)
        if not report["ready"]:
            return {"state":"BLOCKED_PRECHECK", "preflight":report,
                    "provider_invoked":False, "github_published":False}
        if env is not None and env is not os.environ:
            # Avoid temporary mutation of process environment and leaking caller-supplied secrets.
            raise ValueError("live run requires process environment")
    result=pilot(db,task_id,prompt,live=live)
    return {"state":result.get("status","UNKNOWN"),"result":result,
            "github_published":False,"publication_requires_separate_approval":True}


def main():
    p=argparse.ArgumentParser(description="v0.13: opt-in Claude pilot; never directly posts GitHub comments")
    p.add_argument("--db", required=True)
    p.add_argument("--task-id", required=True)
    g=p.add_mutually_exclusive_group(required=True)
    g.add_argument("--prompt")
    g.add_argument("--prompt-file")
    p.add_argument("--live-claude", action="store_true")
    p.add_argument("--preflight-only", action="store_true")
    a=p.parse_args()
    if a.preflight_only:
        result=preflight(live=a.live_claude)
    else:
        prompt=Path(a.prompt_file).read_text(encoding="utf-8-sig") if a.prompt_file else a.prompt
        result=run_pilot(a.db,a.task_id,prompt,live=a.live_claude)
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=="__main__": main()
