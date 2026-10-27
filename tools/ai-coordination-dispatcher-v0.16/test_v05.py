import hashlib,os,tempfile,unittest
from pathlib import Path
from outbox import Outbox
from receipt import reconcile
from review_loop import review_and_draft

class V05(unittest.TestCase):
 def setUp(self):
  t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);self.db=str(Path(t.name)/'state.sqlite')
  o=Outbox(self.db);o.enqueue('x','[DISPATCHER RELAY x]\nVerified body');o.close()
 def _unknown(self):
  o=Outbox(self.db);o.publish('x','x/y',40,'fake',transport=lambda *_: (_ for _ in ()).throw(TimeoutError()));o.close()
 def test_reconcile_exact_body_and_author(self):
  self._unknown();r=reconcile(self.db,'x',[{'id':123,'body':'[DISPATCHER RELAY x]\nVerified body','user':{'login':'bot'}}],'bot');self.assertEqual(r['status'],'RECONCILED')
 def test_absence_never_requeues(self):
  self._unknown();self.assertEqual(reconcile(self.db,'x',[],'bot')['status'],'NOT_FOUND_NO_RETRY');o=Outbox(self.db);self.assertEqual(o.get('x')['state'],'UNKNOWN');o.close()
 def test_wrong_author_not_confirmed(self):
  self._unknown();self.assertEqual(reconcile(self.db,'x',[{'id':123,'body':'[DISPATCHER RELAY x]\nVerified body','user':{'login':'attacker'}}],'bot')['matches'],0)
 def test_duplicate_comments_ambiguous(self):
  self._unknown();c={'id':123,'body':'[DISPATCHER RELAY x]\nVerified body','user':{'login':'bot'}};self.assertEqual(reconcile(self.db,'x',[c,{**c,'id':124}],'bot')['status'],'AMBIGUOUS')
 def test_pended_not_confirmed_by_early_comment(self):
  c={'id':123,'body':'[DISPATCHER RELAY x]\nVerified body','user':{'login':'bot'}};self.assertEqual(reconcile(self.db,'x',[c],'bot')['status'],'OBSERVED_NO_TRANSITION')
 def test_reviewer_only_drafts(self):
  s='ok';e={'invocation_id':'abc','authenticated':True,'sha256':hashlib.sha256(s.encode()).hexdigest(),'review_status':'NEEDS_REVISION','critique':'more proof'}
  r=review_and_draft('job',s,e);self.assertEqual(r['followup']['state'],'DRAFT_REQUIRES_APPROVAL');self.assertFalse(r['auto_dispatched'])
 def test_review_bad_hash_quarantines(self):
  self.assertEqual(review_and_draft('job','ok',{'invocation_id':'a','authenticated':True,'sha256':'0'})['decision'],'QUARANTINED')
 def test_revision_limit(self):
  s='ok';e={'invocation_id':'a','authenticated':True,'sha256':hashlib.sha256(s.encode()).hexdigest(),'review_status':'NEEDS_REVISION'}
  self.assertIsNone(review_and_draft('job',s,e,revision=2)['followup'])
if __name__=='__main__':unittest.main()
