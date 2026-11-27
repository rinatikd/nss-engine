"""Contract tests only: no shell, browser, external AI or private data."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from task_envelope import Identity, Envelope, State

I=Identity("claude","main",17,"https://claude.ai","conversation-1")

def approved():
    e=Envelope("request-1",I,"hello",100)
    e.request_approval(1)
    e.approve(2)
    return e

class EnvelopeContractTests(unittest.TestCase):
    def test_roundtrip(self):
        e=approved();self.assertEqual(e.claim(3,I,"hello"),"request-1")
        e.confirm_sent("request-1",I);e.reply("request-1",I,"answer")
        self.assertEqual(e.state,State.REPLIED)

    def test_no_unapproved_dispatch(self):
        with self.assertRaises(ValueError):
            Envelope("r",I,"x",100).claim(1,I,"x")

    def test_deny_is_terminal(self):
        e=Envelope("r",I,"x",100);e.request_approval(1);e.deny()
        with self.assertRaises(ValueError):e.approve(2)

    def test_expiry(self):
        e=approved()
        with self.assertRaises(ValueError):e.claim(100,I,"hello")
        self.assertEqual(e.state,State.EXPIRED)

    def test_tab_switch_rejected(self):
        e=approved()
        with self.assertRaises(ValueError):
            e.claim(3,Identity("claude","main",18,"https://claude.ai","conversation-1"),"hello")

    def test_payload_change_rejected(self):
        e=approved()
        with self.assertRaises(ValueError):e.claim(3,I,"tampered")

    def test_unknown_outcome_not_retried_after_restart(self):
        e=approved();e.claim(3,I,"hello")
        recovered=Envelope.recover(e.snapshot())
        with self.assertRaises(ValueError):recovered.claim(4,I,"hello")

    def test_request_correlation(self):
        e=approved();e.claim(3,I,"hello")
        with self.assertRaises(ValueError):e.confirm_sent("wrong",I)

    def test_conversation_correlation(self):
        e=approved();e.claim(3,I,"hello");e.confirm_sent("request-1",I)
        other=Identity("claude","main",17,"https://claude.ai","other")
        with self.assertRaises(ValueError):e.reply("request-1",other,"response")

    def test_revoke_blocks_dispatch(self):
        e=approved();e.revoke()
        with self.assertRaises(ValueError):e.claim(3,I,"hello")

    def test_snapshots_hide_content(self):
        e=approved();e.claim(3,I,"hello");e.confirm_sent("request-1",I);e.reply("request-1",I,"secret response")
        snapshot=str(e.snapshot())
        self.assertNotIn("hello",snapshot)
        self.assertNotIn("secret response",snapshot)

    def test_inconsistent_recovery_fails_closed(self):
        e=approved();s=e.snapshot();s["state"]="SENT"
        with self.assertRaises(ValueError):Envelope.recover(s)

if __name__=="__main__":
    unittest.main()
