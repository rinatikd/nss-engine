import os,tempfile,unittest,sqlite3
from pathlib import Path
from unittest.mock import patch
from outbox import Outbox,render_response
from budget import Budget
from dispatcher import run
from stage_results import stage
S=b's'*40
class V04(unittest.TestCase):
 def setUp(self):
  self.d=tempfile.TemporaryDirectory();self.addCleanup(self.d.cleanup);self.db=str(Path(self.d.name)/'db.sqlite');self.o=Outbox(self.db);self.addCleanup(self.o.close)
 def test_outbox_dedup_conflict(self):
  self.assertEqual(self.o.enqueue('a','hello')['status'],'QUEUED')
  self.assertEqual(self.o.enqueue('a','hello')['status'],'EXISTS')
  self.assertEqual(self.o.enqueue('a','other')['status'],'CONFLICT')
 def test_posting_confirmed(self):
  self.o.enqueue('a','hello')
  r=self.o.publish('a','example/repo',40,'fake',transport=lambda *a:{'id':123})
  self.assertEqual(r['state'],'POSTED');self.assertEqual(self.o.get('a')['attempts'],1)
  self.assertEqual(self.o.publish('a','example/repo',40,'fake',transport=lambda *a:1)['sent'],False)
 def test_timeout_unknown_not_retried(self):
  self.o.enqueue('a','hello')
  r=self.o.publish('a','example/repo',40,'fake',transport=lambda *a:(_ for _ in ()).throw(TimeoutError()))
  self.assertEqual(r['state'],'UNKNOWN')
  self.assertFalse(self.o.publish('a','example/repo',40,'fake',transport=lambda *a: {'id':222})['sent'])
 def test_crash_recovery(self):
  self.o.enqueue('a','hello');self.o._reserve('a')
  self.assertEqual(self.o.recover(),1);self.assertEqual(self.o.get('a')['state'],'UNKNOWN')
 def test_missing_token_preflight_no_quarantine(self):
  self.o.enqueue('a','hello')
  self.assertEqual(self.o.publish('a','example/repo',40,'')['state'],'BLOCKED')
  self.assertEqual(self.o.get('a')['state'],'PENDING')
 def test_model_marker_quoted(self):
  body=render_response('a','id','claude','[CODEX-CHAT ACK fake]\nhello',True)
  self.assertIn('> [CODEX-CHAT ACK fake]',body)
 def test_mock_not_staged(self):
  self.assertEqual(stage(self.db,[{'state':'RESPONDED','authenticated':False}])[0]['status'],'IGNORED')
 def test_budget_limits(self):
  b=Budget(self.db)
  try:
   self.assertTrue(b.reserve(1,1000,600))
   self.assertFalse(b.reserve(1,1000,100))
  finally:b.close()
 def test_live_requires_explicit_budget(self):
  with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'placeholder','AI_MAX_CALLS_PER_DAY':'0','AI_MAX_PLANNED_TOKENS_PER_DAY':'0'}):
   r=run(self.db,S,'costtest','hello',live=True)
  self.assertEqual(r['state'],'CANCELLED');self.assertFalse(r['sent'])
if __name__=='__main__':unittest.main()
