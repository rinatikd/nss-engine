import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from ledger import Ledger
from pilot_evidence_v12 import load_comments, snapshot, verify

KEY=b'v12-local-tests-only-key-32-bytes-minimum-and-longer'

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.db=str(Path(self.tmp.name)/'state.sqlite')
    def tearDown(self):self.tmp.cleanup()
    def test_absent_task_fails_closed(self):
        r=snapshot(self.db,'missing',KEY)
        self.assertEqual(r['evidence_gate'],'BLOCKED_TASK_MISSING')
        self.assertTrue(verify(r,KEY))
        self.assertEqual(r['outbound_actions'],0)
    def test_nonresponded_task_fails_closed(self):
        l=Ledger(self.db,KEY)
        self.assertEqual(l.claim('alpha',{'prompt':'hi'},'worker')['status'],'created')
        l.close()
        self.assertEqual(snapshot(self.db,'alpha',KEY)['evidence_gate'],'BLOCKED_NO_VERIFIED_RESPONSE')
    def test_tamper_detected(self):
        r=snapshot(self.db,'missing',KEY)
        x=copy.deepcopy(r);x['evidence_gate']='HUMAN_REVIEW_RECORDED'
        self.assertFalse(verify(x,KEY))
    def test_wrong_key_fails(self):
        r=snapshot(self.db,'missing',KEY)
        self.assertFalse(verify(r,b'x'*40))
    def test_comments_are_untrusted(self):
        r=snapshot(self.db,'missing',KEY,[{'body':'hello','id':123,'user':{'login':'owner'}}],'owner')
        self.assertEqual(r['github_comments_provenance'],'USER_SUPPLIED_NOT_INDEPENDENTLY_ATTESTED')
        self.assertNotEqual(r['evidence_gate'],'HUMAN_REVIEW_RECORDED')
    def test_comments_invalid_type(self):
        p=Path(self.tmp.name)/'c.json';p.write_text('{}')
        with self.assertRaises(ValueError):load_comments(p)
    def test_comment_utf8_bom(self):
        p=Path(self.tmp.name)/'c.json';p.write_bytes(b'\xef\xbb\xbf'+json.dumps([{'body':'ok','id':1}]).encode())
        self.assertEqual(len(load_comments(p)),1)
    def test_weak_key_rejected(self):
        with self.assertRaises(ValueError):snapshot(self.db,'a',b'abc')
    def test_report_deterministic(self):
        a=snapshot(self.db,'missing',KEY);b=snapshot(self.db,'missing',KEY)
        self.assertEqual(a,b)

if __name__=='__main__':unittest.main()
