import hashlib,json,tempfile,unittest
from pathlib import Path
from ledger import Ledger
from outbox import Outbox,render_response
from review_queue import ReviewQueue
from cycle_v11 import inspect

KEY=b'deterministic-local-test-key-32-bytes-ABC'

class V11(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=str(Path(self.tmp.name)/'db.sqlite');self.task='t001'
 def tearDown(self):self.tmp.cleanup()
 def create(self,auth=True):
  l=Ledger(self.db,KEY);cl=l.claim(self.task,{'prompt':'P','provider':'claude'},'test');token=cl['token'];l.transition(self.task,token,'CLAIMED','DISPATCHING')
  reply='Answer with evidence';digest=hashlib.sha256(reply.encode()).hexdigest()
  l.transition(self.task,token,'DISPATCHING','RESPONDED',{'provider':'claude','authenticated':auth,'invocation_id':'msg_fixture','response':reply,'response_sha256':digest});l.close()
  return reply
 def posted(self, reply):
  o=Outbox(self.db);o.enqueue(self.task,render_response(self.task,'msg_fixture','claude',reply,True))
  o.conn.execute("UPDATE github_outbox SET state='POSTED',comment_id=123 WHERE task_id=?",(self.task,));body=o.conn.execute('SELECT body FROM github_outbox WHERE task_id=?',(self.task,)).fetchone()[0];o.close()
  return [{'id':123,'body':body,'user':{'login':'dispatcher-bot'}}]
 def test_missing(self):self.assertEqual(inspect(self.db,self.task,KEY)['gate'],'BLOCKED_TASK_MISSING')
 def test_mock_denied(self):self.create(auth=False);self.assertEqual(inspect(self.db,self.task,KEY)['gate'],'QUARANTINED_UNTRUSTED_PROVIDER_RESULT')
 def test_outbox_missing(self):self.create();self.assertEqual(inspect(self.db,self.task,KEY)['gate'],'AWAITING_OUTBOX')
 def test_posted_requires_readback(self):self.posted(self.create());self.assertEqual(inspect(self.db,self.task,KEY)['gate'],'NEEDS_READONLY_GITHUB_RECONCILIATION')
 def test_wrong_author_denied(self):
  cs=self.posted(self.create());cs[0]['user']['login']='untrusted';self.assertEqual(inspect(self.db,self.task,KEY,cs,'dispatcher-bot')['gate'],'UNVERIFIED_GITHUB_RECEIPT')
 def test_wrong_body_denied(self):
  cs=self.posted(self.create());cs[0]['body']='other';self.assertEqual(inspect(self.db,self.task,KEY,cs,'dispatcher-bot')['gate'],'UNVERIFIED_GITHUB_RECEIPT')
 def test_readback_without_review(self):
  cs=self.posted(self.create());self.assertEqual(inspect(self.db,self.task,KEY,cs,'dispatcher-bot')['gate'],'AWAITING_HUMAN_REVIEW')
 def test_revision_draft_not_dispatched(self):
  reply=self.create();cs=self.posted(reply);q=ReviewQueue(self.db);q.decide(self.task,reply,'REVISE','Need evidence');q.close()
  r=inspect(self.db,self.task,KEY,cs,'dispatcher-bot');self.assertEqual(r['gate'],'REVIEWED_REQUIRES_HUMAN_ACTION');self.assertFalse(r['auto_dispatched']);self.assertEqual(r['followup_id'],'t001.r1')
 def test_wrong_review_hash_denied(self):
  reply=self.create();cs=self.posted(reply);q=ReviewQueue(self.db);q.decide(self.task,'different','APPROVE');q.close()
  self.assertEqual(inspect(self.db,self.task,KEY,cs,'dispatcher-bot')['gate'],'QUARANTINED_REVIEW_HASH_MISMATCH')
 def test_duplicate_comment_denied(self):
  cs=self.posted(self.create());cs.append(dict(cs[0]));self.assertEqual(inspect(self.db,self.task,KEY,cs,'dispatcher-bot')['gate'],'UNVERIFIED_GITHUB_RECEIPT')
if __name__=='__main__':unittest.main()
