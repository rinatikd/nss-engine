import os, tempfile, unittest
from pathlib import Path
from readiness import inspect
from outbox import Outbox
from reconcile_pilot import reconcile

class V07(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=str(Path(self.tmp.name)/'state.sqlite')
 def tearDown(self):self.tmp.cleanup()
 def test_preflight_closed_default(self):
  r=inspect({});self.assertFalse(r['ready']);self.assertGreater(len(r['errors']),3);self.assertFalse(r['credentials_printed'])
 def test_preflight_approval_required(self):
  e={'ANTHROPIC_API_KEY':'x'*20,'AI_LEDGER_HMAC_KEY':'y'*40,'GITHUB_TOKEN':'z'*20,'GITHUB_REPOSITORY':'owner/repo','GITHUB_ISSUE_NUMBER':'40','AI_MAX_CALLS_PER_DAY':'1','AI_MAX_PLANNED_TOKENS_PER_DAY':'2000'}
  self.assertFalse(inspect(e)['ready']);e.update(AI_APPROVE_REAL_REQUEST='YES_I_APPROVE_ONE_PAID_CLAUDE_REQUEST',AI_APPROVE_GITHUB_WRITE='YES_I_APPROVE_GITHUB_ISSUE_WRITE');self.assertTrue(inspect(e)['ready'])
 def test_empty_repo_denied(self):
  self.assertFalse(inspect({'GITHUB_REPOSITORY':'https://evil.test/repo'})['ready'])
 def test_precheck_does_not_post(self):
  r=reconcile(self.db,'abc',None,'40',None);self.assertEqual(r['status'],'BLOCKED')
 def test_read_only_exact_match(self):
  o=Outbox(self.db);o.enqueue('task1','body1');o.conn.execute("UPDATE github_outbox SET state='UNKNOWN' WHERE task_id='task1'");o.close()
  self.assertEqual(reconcile(self.db,'task1','owner/repo',40,'secret',lambda *a:[{'id':12,'body':'body1'}])['status'],'MATCH_OBSERVED_UNVERIFIED')
  o=Outbox(self.db);self.assertEqual(o.get('task1')['state'],'UNKNOWN');o.close()
 def test_read_only_other_body_not_reconciled(self):
  o=Outbox(self.db);o.enqueue('task2','body2');o.conn.execute("UPDATE github_outbox SET state='UNKNOWN' WHERE task_id='task2'");o.close()
  self.assertEqual(reconcile(self.db,'task2','owner/repo',40,'secret',lambda *a:[{'id':15,'body':'different'}])['status'],'UNRESOLVED')
 def test_ambiguous_duplicates_not_reconciled(self):
  o=Outbox(self.db);o.enqueue('task3','body3');o.conn.execute("UPDATE github_outbox SET state='UNKNOWN' WHERE task_id='task3'");o.close()
  r=reconcile(self.db,'task3','owner/repo',40,'secret',lambda *a:[{'id':1,'body':'body3'},{'id':2,'body':'body3'}]);self.assertEqual(r['matches'],2)
if __name__=='__main__':unittest.main()
