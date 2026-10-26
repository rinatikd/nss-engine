import io, json, os, tempfile, unittest
from pathlib import Path
from relay import State, Request, parse_request, run_codex, RelayError, codex_disabled, SENDER_ID, GitHub

class RelayTests(unittest.TestCase):
    def comment(self, body="[CODEX-CHAT REQUEST req_0001]\nReview this design.", *, uid=SENDER_ID, login="rinatikd", cid=100):
        return {"id":cid,"user":{"id":uid,"login":login},"body":body}
    def test_sender_requires_id_and_login(self):
        self.assertIsNone(parse_request(self.comment(uid=7)))
        self.assertIsNone(parse_request(self.comment(login="rinatikd-alt")))
        self.assertIsNotNone(parse_request(self.comment()))
    def test_tampered_body_changes_fingerprint(self):
        original=parse_request(self.comment())
        edited=parse_request(self.comment("[CODEX-CHAT REQUEST req_0001]\nChanged request."))
        self.assertNotEqual(original.fingerprint,edited.fingerprint)
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
    def test_restart_converts_running_to_unknown_and_terminal(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"state.sqlite3"; s=State(p); s.baseline([])
            r=parse_request(self.comment()); s.claim(r); s.state(r.request_id,"RUNNING"); s.close()
            s=State(p); self.assertEqual("UNKNOWN",s.db.execute("select state from requests").fetchone()[0])
            with self.assertRaises(RelayError): s.state(r.request_id,"DONE")
            s.close()
    def test_publish_uses_stdin_and_verifies_correlated_response(self):
        calls=[]; old=__import__('shutil').which; __import__('shutil').which=lambda _:"gh-test"
        body="[CODEX-CHAT RESPONSE req_0001]\n\nanswer"
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
            answer=run_codex("untrusted payload","req_0001",confirm=lambda _:"RUN req_0001",popen=fake,env={})
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
                run_codex("x","req_0001",confirm=lambda _:"RUN req_0001",popen=lambda *a,**k:proc,env={})
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
                run_codex("x","req_0001",confirm=lambda _:"RUN req_0001",popen=lambda *a,**k:proc,env={})
        finally: __import__('shutil').which=old
        self.assertTrue(proc.killed)
    def test_run_confirmation_mismatch_denies_before_process(self):
        invoked=[]; old=__import__('shutil').which; __import__('shutil').which=lambda _:"codex-test"
        try:
            with self.assertRaises(RelayError): run_codex("x","req_0001",confirm=lambda _:"RUN wrong",popen=lambda *a,**k:invoked.append(1),env={})
        finally: __import__('shutil').which=old
        self.assertEqual([],invoked)

if __name__ == "__main__": unittest.main()


