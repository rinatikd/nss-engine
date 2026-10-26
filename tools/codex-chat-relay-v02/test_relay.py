import io, json, os, tempfile, unittest
from pathlib import Path
from relay import State, Request, parse_request, run_codex, RelayError, codex_disabled, codex_capability_preflight, SENDER_ID, GitHub

class RelayTests(unittest.TestCase):
    def comment(self, body="[CODEX-CHAT REQUEST req_0001]\nReview this design.", *, uid=SENDER_ID, login="rinatikd", cid=100):
        return {"id":cid,"user":{"id":uid,"login":login},"body":body}
    def test_sender_requires_id_and_login(self):
        self.assertIsNone(parse_request(self.comment(uid=7)))
        self.assertIsNone(parse_request(self.comment(login="rinatikd-alt")))
        self.assertIsNotNone(parse_request(self.comment()))
    def test_capability_preflight_allows_only_empty_config(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"config.toml"; p.write_text("# empty and no extensions\n",encoding="utf-8")
            self.assertEqual((True,[]),codex_capability_preflight(p,env={},verify_cli=False))
    def test_capability_preflight_blocks_additional_mcp_plugins_apps_hooks(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"config.toml"
            p.write_text('[mcp_servers.github]\ncommand="gh"\n[plugins.demo]\nenabled=true\n[apps.connector_demo.tools.x]\napproval_mode="approve"\n[hooks.pre_tool_use]\ncommand="x"\n',encoding="utf-8")
            allowed,findings=codex_capability_preflight(p,env={},verify_cli=False)
            self.assertFalse(allowed)
            self.assertTrue(any("github" in x for x in findings))
            self.assertTrue(any("plugins" in x for x in findings))
            self.assertTrue(any("apps" in x for x in findings))
            self.assertTrue(any("hooks" in x for x in findings))
    def test_capability_preflight_fails_closed_missing_or_malformed(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"missing.toml"
            self.assertFalse(codex_capability_preflight(p,env={},verify_cli=False)[0])
            p.write_text("[broken",encoding="utf-8")
            self.assertFalse(codex_capability_preflight(p,env={},verify_cli=False)[0])
    def test_cli_version_preflight_fails_closed_on_unreviewed_version(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"config.toml"; p.write_text("",encoding="utf-8")
            class Version:
                returncode=0; stdout="codex-cli 9.9.9\n"
            allowed,findings=codex_capability_preflight(p,env={},verify_cli=True,version_runner=lambda *a,**k:Version())
            self.assertFalse(allowed); self.assertIn("not reviewed",findings[0])
    def test_cli_version_preflight_accepts_reviewed_version(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"config.toml"; p.write_text("",encoding="utf-8")
            class Version:
                returncode=0; stdout="codex-cli 0.164.0\n"
            self.assertEqual((True,[]),codex_capability_preflight(p,env={},verify_cli=True,version_runner=lambda *a,**k:Version()))
    def test_run_codex_blocks_extra_mcp_before_confirmation_or_launch(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"config.toml"; p.write_text('[mcp_servers.extra]\ncommand="x"\n',encoding="utf-8")
            called=[]
            check=lambda env: codex_capability_preflight(p,env)
            with self.assertRaisesRegex(RelayError,"preflight blocked"):
                run_codex("x","req_0001",confirm=lambda _:called.append("confirm"),popen=lambda *a,**k:called.append("launch"),env={},capability_check=check)
            self.assertEqual([],called)
    def test_tampered_body_changes_fingerprint(self):
        original=parse_request(self.comment())
        edited=parse_request(self.comment("[CODEX-CHAT REQUEST req_0001]\nChanged request."))
        self.assertNotEqual(original.fingerprint,edited.fingerprint)
    def test_unicode_and_multiline_request(self):
        text="[CODEX-CHAT REQUEST req_0001]\n\u0412\u043e\u043f\u0440\u043e\u0441: \u043f\u0440\u0438\u0432\u0435\u0442 \U0001f9ea\n\u0412\u0442\u043e\u0440\u0430\u044f \u0441\u0442\u0440\u043e\u043a\u0430."
        self.assertEqual(parse_request(self.comment(text)).body,"\u0412\u043e\u043f\u0440\u043e\u0441: \u043f\u0440\u0438\u0432\u0435\u0442 \U0001f9ea\n\u0412\u0442\u043e\u0440\u0430\u044f \u0441\u0442\u0440\u043e\u043a\u0430.")
    def test_oversized_request_rejected(self):
        text="[CODEX-CHAT REQUEST req_0001]\n"+"A"*12001
        self.assertIsNone(parse_request(self.comment(text)))
    def test_malformed_and_secret_rejected(self):
        self.assertIsNone(parse_request(self.comment("ordinary")))
        self.assertIsNone(parse_request(self.comment("[CODEX-CHAT REQUEST req_0001]\nhello\x1b[31mred")))
        self.assertIsNone(parse_request(self.comment("[CODEX-CHAT REQUEST req_0001]\ntoken ghp_"+"a"*30)))
    def test_baseline_never_processes_existing_request(self):
        with tempfile.TemporaryDirectory() as d:
            s=State(Path(d)/"state.sqlite3"); r=parse_request(self.comment())
            self.assertTrue(s.baseline([self.comment()])); self.assertFalse(s.claim(r)); s.close()
    def test_duplicate_comment_and_request_id_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            s=State(Path(d)/"state.sqlite3"); s.baseline([])
            r=parse_request(self.comment()); self.assertTrue(s.claim(r)); self.assertFalse(s.claim(r))
            r2=parse_request(self.comment(cid=101)); self.assertFalse(s.claim(r2)); s.close()
    def test_restart_converts_running_and_publishing_to_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"state.sqlite3"; s=State(p); s.baseline([])
            for i,state in enumerate(("RUNNING","PUBLISHING")):
                rid=f"req_{i:04d}"; s.claim(parse_request(self.comment(f"[CODEX-CHAT REQUEST {rid}]\nReview",cid=100+i))); s.state(rid,state)
            s.close(); s=State(p)
            self.assertEqual(["UNKNOWN","UNKNOWN"],[x[0] for x in s.db.execute("select state from requests order by request_id")])
            s.close()
    def test_restart_converts_running_to_unknown_and_terminal(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"state.sqlite3"; s=State(p); s.baseline([])
            r=parse_request(self.comment()); s.claim(r); s.state(r.request_id,"RUNNING"); s.close()
            s=State(p); self.assertEqual("UNKNOWN",s.db.execute("select state from requests").fetchone()[0])
            with self.assertRaises(RelayError): s.state(r.request_id,"DONE")
            s.close()
    def test_publish_uses_stdin_and_verifies_correlated_response(self):
        calls=[]; old=__import__('shutil').which; __import__('shutil').which=lambda _:"gh-test"
        body="[CODEX-CHAT RESPONSE req_0001]\n\n\u041e\u0442\u0432\u0435\u0442: \u043f\u0440\u0438\u0432\u0435\u0442 \U0001f9ea\n\u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0430\u044f \u0441\u0442\u0440\u043e\u043a\u0430"
        class P:
            returncode=0; stdout=json.dumps({"id":1234,"user":{"id":337319789},"body":body})
        def fake(args,**kwargs): calls.append((args,kwargs)); return P()
        try: result=GitHub(runner=fake).post(body)
        finally: __import__('shutil').which=old
        args,kwargs=calls[0]; self.assertEqual(args[-2:], ["--input","-"])
        self.assertNotIn(body," ".join(args)); self.assertEqual(__import__('json').loads(kwargs["input"]),{"body":body})
        self.assertEqual(result["id"],1234)
    def test_github_auth_identity_mismatch_fails_closed(self):
        old=__import__('shutil').which; __import__('shutil').which=lambda _:"gh-test"
        class P:
            returncode=0; stdout=json.dumps({"id":1,"login":"other"})
        try:
            with self.assertRaisesRegex(RelayError,"identity mismatch"): GitHub(runner=lambda *a,**k:P()).verify()
        finally: __import__('shutil').which=old
    def test_closed_or_wrong_issue_fails_closed(self):
        old=__import__('shutil').which; __import__('shutil').which=lambda _:"gh-test"
        class P:
            returncode=0
            def __init__(self,text): self.stdout=text
        replies=[json.dumps({"id":337319789,"login":"rinatikd"}),json.dumps({"number":40,"state":"closed"})]
        def fake(*a,**k): return P(replies.pop(0))
        try:
            with self.assertRaisesRegex(RelayError,"Issue #40 unavailable"): GitHub(runner=fake).verify()
        finally: __import__('shutil').which=old
    def test_post_timeout_then_restart_is_unknown_and_never_retried(self):
        old=__import__('shutil').which; __import__('shutil').which=lambda _:"gh-test"
        class P:
            returncode=1; stdout=""; stderr=""
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"state.sqlite3"; state=State(p); state.baseline([])
            req=self.comment("[CODEX-CHAT REQUEST req_0001]\nsynthetic",cid=100)
            r=parse_request(req); state.claim(r); state.state(r.request_id,"RUNNING"); state.state(r.request_id,"PUBLISHING")
            server_accepted=[]
            def accepted_then_timeout(*a,**k):
                server_accepted.append(json.loads(k["input"])["body"])
                return P()  # server accepted the payload; client lost the response
            try:
                with self.assertRaisesRegex(RelayError,"GitHub API request failed"):
                    GitHub(runner=accepted_then_timeout).post("[CODEX-CHAT RESPONSE req_0001]\n\nsynthetic")
            finally: __import__('shutil').which=old
            self.assertEqual(1,len(server_accepted))
            state.event(r.request_id,"PUBLISH_UNKNOWN"); state.state(r.request_id,"UNKNOWN"); state.close()
            state=State(p)
            self.assertEqual("UNKNOWN",state.db.execute("select state from requests").fetchone()[0])
            self.assertFalse(state.claim(r)); self.assertEqual(1,len(server_accepted)); state.close()
    def test_publish_malformed_result_is_unknown(self):
        old=__import__('shutil').which; __import__('shutil').which=lambda _:"gh-test"
        class P:
            returncode=0; stdout="not-json"
        try:
            with self.assertRaisesRegex(RelayError,"outcome unknown"): GitHub(runner=lambda *a,**k:P()).post("body")
        finally: __import__('shutil').which=old
    def test_hourly_launch_limit_is_persistent(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"state.sqlite3"; s=State(p); s.baseline([])
            for i in range(5): s.reserve_run(f"req_{i:04d}")
            with self.assertRaisesRegex(RelayError,"hourly limit"): s.reserve_run("req_extra")
            s.close(); s=State(p)
            with self.assertRaisesRegex(RelayError,"hourly limit"): s.reserve_run("req_extra")
            s.close()
    def test_codex_disabled_is_fail_closed(self):
        self.assertTrue(codex_disabled({"CODEX_DISABLED":"true"}))
        self.assertFalse(codex_disabled({"CODEX_DISABLED":"0"}))
        with self.assertRaisesRegex(RelayError,"CODEX_DISABLED"):
            run_codex("hi","req_0001",env={"CODEX_DISABLED":"1"})
    def test_malformed_utf8_output_is_rejected(self):
        old=__import__('shutil').which; __import__('shutil').which=lambda _:"codex-test"
        class P:
            def __init__(self): self.stdin=io.BytesIO(); self.stdout=io.BytesIO(b"bad\xffutf8")
            def wait(self,timeout=None): return 0
            def kill(self): pass
        try:
            with self.assertRaisesRegex(RelayError,"malformed"):
                run_codex("x","req_0001",confirm=lambda _:"RUN req_0001",popen=lambda *a,**k:P(),env={},capability_check=lambda **_: (True,[]))
        finally: __import__('shutil').which=old
    def test_terminal_control_characters_are_sanitized(self):
        old=__import__('shutil').which; __import__('shutil').which=lambda _:"codex-test"
        class P:
            def __init__(self): self.stdin=io.BytesIO(); self.stdout=io.BytesIO(b"hello\x1b[31mred")
            def wait(self,timeout=None): return 0
            def kill(self): pass
        try:
            answer=run_codex("x","req_0001",confirm=lambda _:"RUN req_0001",popen=lambda *a,**k:P(),env={},capability_check=lambda **_: (True,[]))
        finally: __import__('shutil').which=old
        self.assertEqual("hello?[31mred",answer)
    def test_no_shell_and_prompt_only_stdin(self):
        calls=[]
        class P:
            def __init__(self): self.stdin=io.BytesIO(); self.stdout=io.BytesIO(b"answer")
            def wait(self,timeout=None): return 0
            def kill(self): pass
        def fake(args,**kw): calls.append((args,kw)); return P()
        old=__import__('shutil').which
        __import__('shutil').which=lambda name: "codex-test" if name=="codex" else None
        try:
            answer=run_codex("untrusted payload","req_0001",confirm=lambda _:"RUN req_0001",popen=fake,env={},capability_check=lambda **_: (True,[]))
        finally: __import__('shutil').which=old
        a,k=calls[0]; self.assertFalse(k["shell"]); self.assertIs(k["stdin"],__import__("subprocess").PIPE); self.assertIs(k["stdout"],__import__("subprocess").PIPE)
        self.assertNotIn("untrusted payload",a); self.assertEqual("-",a[-1]); self.assertEqual("answer",answer)
        self.assertIn("--sandbox",a); self.assertIn("read-only",a); self.assertIn("shell_tool",a); self.assertIn("apps",a)
    def test_output_limit_kills_codex_process(self):
        old=__import__('shutil').which; __import__('shutil').which=lambda _:"codex-test"
        class P:
            def __init__(self): self.stdin=io.BytesIO(); self.stdout=io.BytesIO(b"x"*25000); self.killed=False
            def wait(self,timeout=None): return 0
            def kill(self): self.killed=True
        proc=P()
        try:
            with self.assertRaisesRegex(RelayError,"exceeds limit"):
                run_codex("x","req_0001",confirm=lambda _:"RUN req_0001",popen=lambda *a,**k:proc,env={},capability_check=lambda **_: (True,[]))
        finally: __import__('shutil').which=old
        self.assertTrue(proc.killed)
    def test_timeout_kills_local_process(self):
        old=__import__('shutil').which; __import__('shutil').which=lambda _:"codex-test"
        class P:
            def __init__(self): self.stdin=io.BytesIO(); self.stdout=io.BytesIO(); self.killed=False; self.calls=0
            def wait(self,timeout=None):
                self.calls+=1
                if self.calls==1: raise __import__('subprocess').TimeoutExpired("codex",timeout)
                return -9
            def kill(self): self.killed=True
        proc=P()
        try:
            with self.assertRaisesRegex(RelayError,"timed out"):
                run_codex("x","req_0001",confirm=lambda _:"RUN req_0001",popen=lambda *a,**k:proc,env={},capability_check=lambda **_: (True,[]))
        finally: __import__('shutil').which=old
        self.assertTrue(proc.killed)
    def test_run_confirmation_mismatch_denies_before_process(self):
        invoked=[]; old=__import__('shutil').which; __import__('shutil').which=lambda _:"codex-test"
        try:
            with self.assertRaises(RelayError): run_codex("x","req_0001",confirm=lambda _:"RUN wrong",popen=lambda *a,**k:invoked.append(1),env={},capability_check=lambda **_: (True,[]))
        finally: __import__('shutil').which=old
        self.assertEqual([],invoked)

if __name__ == "__main__": unittest.main()


