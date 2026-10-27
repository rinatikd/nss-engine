import tempfile,unittest
from pathlib import Path
from review_queue import ReviewQueue
class ReviewV08(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.db=str(Path(self.t.name)/'test.sqlite')
 def act(self,*args,**kw):
  q=ReviewQueue(self.db)
  try:return q.decide(*args,**kw)
  finally:q.close()
 def test_revision_draft(self):
  x=self.act('job','answer','REVISE','Missing source');self.assertEqual(x['followup_id'],'job.r1');self.assertFalse(x['auto_dispatched'])
  q=ReviewQueue(self.db);self.assertEqual(q.draft('job.r1')['state'],'DRAFT_REQUIRES_APPROVAL');q.close()
 def test_idempotent_review(self):
  self.act('job','answer','APPROVE');self.assertEqual(self.act('job','answer','APPROVE')['status'],'EXISTS')
 def test_conflicting_response(self):
  self.act('job','answer','APPROVE');self.assertEqual(self.act('job','changed','APPROVE')['status'],'CONFLICT')
 def test_conflicting_decision(self):
  self.act('job','answer','APPROVE');self.assertEqual(self.act('job','answer','REJECT')['status'],'CONFLICT')
 def test_revision_limit(self):
  x=self.act('job','answer','REVISE','more detail',revision=2);self.assertIsNone(x['followup_id'])
 def test_critique_required(self):
  with self.assertRaises(ValueError):self.act('job','answer','REVISE')
 def test_invalid_id(self):
  with self.assertRaises(ValueError):self.act('../escape','answer','APPROVE')
 def test_persistent_across_instances(self):
  self.act('job','answer','REVISE','Citation missing');q=ReviewQueue(self.db)
  try:self.assertIn('Citation missing',q.draft('job.r1')['prompt'])
  finally:q.close()
if __name__=='__main__': unittest.main()
