"""Real Ollama -> MCP -> executor/reviewer integration. Never substitutes mocks."""
import argparse
import asyncio
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

from orchestrator import Store
from ai_reviewer import parse_verdict, review_findings

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from calculation_check import validate_calculation

PROMPT = (
    "Рассчитай общий поток и архив за сутки: 4 камеры, каждая передаёт 2 Мбит/с, "
    "непрерывная запись 24 часа. Используй десятичные ГБ (1 ГБ = 10^9 байт), "
    "без накладных расходов. Ответь кратко двумя строками: «Поток: ...» и «Архив: ...», "
    "в каждой приведи формулу. Не утверждай, что запускал программы или проверял чертежи."
)
RUBRIC = (
    "Нужно правильно рассчитать оба значения с формулами: поток 4 × 2 = 8 Мбит/с; "
    "архив 8 × 10^6 / 8 × 86400 / 10^9 = 86.4 десятичных ГБ. "
    "Не путать биты и байты, ГБ и ГиБ. Ответ должен быть кратким и не содержать "
    "выдуманных утверждений о запуске программ. Для верного ответа верни APPROVE; необязательные рекомендации допустимы."
)


def local_json(path):
    conn = http.client.HTTPConnection("127.0.0.1", 11434, timeout=5)
    try:
        conn.request("GET", path)
        response = conn.getresponse()
        if response.status != 200:
            raise RuntimeError("Local runtime is not ready")
        return json.loads(response.read(1_000_000))
    finally:
        conn.close()


def validate_task(task):
    if task["state"] != "COMPLETED" or task["spec"]["mode"] != "local":
        raise ValueError("Real local workflow did not complete: " + task["state"])
    attempts = task["attempts"]
    if not attempts or {a["role"] for a in attempts} != {"executor", "reviewer"}:
        raise ValueError("Both real agent roles must execute")
    for attempt in attempts:
        result = attempt.get("result") or {}
        if attempt["state"] != "RESPONDED" or result.get("provider") != "ollama":
            raise ValueError("Mock/uncertain attempts cannot establish readiness")
        if result.get("stop_reason") != "end_turn" or result.get("sha256") != hashlib.sha256(result["text"].encode()).hexdigest():
            raise ValueError("Response completeness/integrity failed")
        if (result.get("usage") or {}).get("output_tokens", 0) < 1:
            raise ValueError("No measured model generation")
    final_executor = next(a for a in reversed(attempts) if a["role"] == "executor")
    if final_executor["result"]["text"] != task["answer"]:
        raise ValueError("Final answer is not bound to the executor response")
    validate_calculation(task["answer"])
    final_review = next(a for a in reversed(attempts) if a["role"] == "reviewer")
    verdict = parse_verdict(final_review["result"]["text"])
    if verdict["decision"] != "APPROVE" or review_findings(verdict)["blocking_issues"]:
        raise ValueError("Final review did not approve the answer")


async def verify(db, executor_model, reviewer_model, timeout):
    models = local_json("/api/tags").get("models", [])
    selected = {}
    for role, name in (("executor", executor_model), ("reviewer", reviewer_model)):
        model = next((m for m in models if m.get("name") == name), None)
        if not model or not re.fullmatch(r"[a-f0-9]{64}", model.get("digest", "")):
            raise ValueError("A completely installed model with a digest is required for " + role)
        selected[role] = model
    version = local_json("/api/version").get("version")
    params = StdioServerParameters(command=sys.executable, args=[
        str(Path(__file__).parent / "unified_runtime.py"), "--db", db, "--ui-port", "18765"])
    started = time.monotonic()
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            catalog = await session.list_tools()
            async def call(name, arguments):
                reply = await session.call_tool(name, arguments)
                if reply.isError or reply.structuredContent is None:
                    raise RuntimeError("MCP tool did not return a verified structured result: " + name)
                return reply.structuredContent
            health = await call("dispatcher_health", {})
            if health["paid_api_allowed"] is not False:
                raise ValueError("Paid API policy changed")
            await call("dispatcher_start_local_worker", {"executor_model": executor_model, "reviewer_model": reviewer_model})
            ui = http.client.HTTPConnection("127.0.0.1", 18765, timeout=5)
            try:
                ui.request("GET", "/api/state")
                response = ui.getresponse()
                ui_state = json.loads(response.read(1_000_000))
                if response.status != 200 or not ui_state["worker"]["running"]:
                    raise ValueError("UI cannot observe the MCP-started worker")
            finally:
                ui.close()
            submitted = await call("dispatcher_submit_task", {"request_id": uuid.uuid4().hex, "prompt": PROMPT, "rubric": RUBRIC, "max_revisions": 1})
            task_id = submitted["task_id"]
            try:
                while time.monotonic() - started < timeout:
                    task = await call("dispatcher_get_task", {"task_id": task_id})
                    if task["state"] in {"COMPLETED", "REJECTED", "REVISION_LIMIT", "QUARANTINED", "UNKNOWN", "CANCELLED"}:
                        break
                    await asyncio.sleep(1)
            finally:
                await call("dispatcher_stop_worker", {})
    # Full attempts are read only from this private synthetic fixture database.
    # The MCP result remains sanitized: no prompts/requests/attempt payloads exposed.
    store = Store(db)
    try:
        full_task = store.status(task_id)
    finally:
        store.close()
    if full_task["state"] != task["state"]:
        raise ValueError("MCP and persisted state differ")
    task = full_task
    return {"check": "real-ollama-mcp-executor-reviewer", "passed": False,
            "ollama_version": version, "installed_models": selected,
            "mcp_tools": [t.name for t in catalog.tools], "elapsed_seconds": round(time.monotonic() - started, 2),
            "paid_model_api_calls": 0, "chatgpt_web_app_verified": False,
            "ui_observed_mcp_worker": True, "task": task}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", help="Use one installed model for both roles")
    parser.add_argument("--executor-model", default="qwen2.5:3b")
    parser.add_argument("--reviewer-model", default="qwen2.5:7b")
    parser.add_argument("--timeout", type=int, default=360)
    args = parser.parse_args()
    executor_model = args.model or args.executor_model
    reviewer_model = args.model or args.reviewer_model
    evidence = asyncio.run(verify(args.db, executor_model, reviewer_model, args.timeout))
    # Preserve genuine responses even on a failed assertion; never turn failure into PASS.
    Path(args.output).write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    task = evidence["task"]
    if os.environ.get("GITHUB_ACTIONS") == "true":
        observation = {"state": task["state"], "answer": task["answer"], "attempts": [{
            "role": a["role"], "state": a["state"], "text": (a.get("result") or {}).get("text"),
            "usage": (a.get("result") or {}).get("usage"),
            "generation_options": (a.get("result") or {}).get("generation_options"),
        } for a in task["attempts"]]}
        # Fixed synthetic calculation only. Escape command delimiters/newlines in model data.
        message = json.dumps(observation, ensure_ascii=False)[:3500]
        message = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print("::notice title=A2A observed result::" + message, flush=True)
    try:
        validate_task(task)
    except ValueError as exc:
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print("::error title=A2A validation::" + str(exc), flush=True)
        raise
    evidence["passed"] = True
    Path(args.output).write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = "\n## Real local model integration: PASS\n\n"
    summary += "Executor: `" + executor_model + "`; reviewer: `" + reviewer_model + "`. Provider API charges: 0. ChatGPT web app: not verified.\n\n"
    summary += "Synthetic calculation answer (untrusted model text):\n\n"
    summary += "\n".join("> " + line for line in evidence["task"]["answer"].splitlines()) + "\n"
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as handle:
            handle.write(summary)
    print("PASS: real model -> MCP -> executor -> reviewer -> persisted answer; paid API calls=0")


if __name__ == "__main__":
    main()
