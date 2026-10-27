import tempfile,unittest
from pathlib import Path
from outbox import Outbox
from pilot_ops_v14 import doctor,inspect,verify_github

class V14(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=str(Path(self.tmp.name)/'state.sqlite')
 def tearDown(self):self.tmp.cleanup()
 def test_no_db(self):self.assertEqual(inspect(self.db,'X')['status'],'NO_DATABASE')
 def test_doctor_default_blocks(self):
  r=doctor({});self.assertEqual(r['status'],'BLOCKED_PRECHECK');self.assertEqual(r['calls_sent'],0)
 def test_doctor_does_not_print_credentials(self):
  e={'ANTHROPIC_API_KEY':'sample-secret-bad-not-real','GITHUB_TOKEN':'secret-xyz-123456789','AI_LEDGER_HMAC_KEY':'x'*40}
  self.assertNotIn('secret-xyz',repr(doctor(e)))
 def test_inspect_missing(self):
  o=Outbox(self.db);o.close();self.assertEqual(inspect(self.db,'T')['status'],'NO_OUTBOX_RECORD')
 def test_inspect_pending(self):
  o=Outbox(self.db);o.enqueue('T','Hello');o.close()
  self.assertEqual(inspect(self.db,'T')['outbox']['state'],'PENDING')
 def test_github_exact_match(self):
  o=Outbox(self.db);o.enqueue('T','Hello');o.close()
  f=lambda *args:[{'id':42,'body':'Hello','user':{'login':'publisher'}}]
  r=verify_github(self.db,'T','owner/repo',40,'redacted','publisher',fetcher=f)
  self.assertEqual(r['status'],'GITHUB_COMMENT_OBSERVED');self.assertFalse(r['provider_identity_verified'])
 def test_wrong_actor_rejected(self):
  o=Outbox(self.db);o.enqueue('T','Hello');o.close()
  f=lambda *args:[{'id':42,'body':'Hello','user':{'login':'someone_else'}}]
  self.assertEqual(verify_github(self.db,'T','owner/repo',40,'key','publisher',f)['status'],'NOT_OBSERVED')
 def test_multiple_exact_ambiguous(self):
  o=Outbox(self.db);o.enqueue('T','Hello');o.close()
  f=lambda *args:[{'id':42,'body':'Hello','user':{'login':'publisher'}},{'id':43,'body':'Hello','user':{'login':'publisher'}}]
  self.assertEqual(verify_github(self.db,'T','owner/repo',40,'key','publisher',f)['status'],'AMBIGUOUS')
 def test_read_error_no_retry(self):
  o=Outbox(self.db);o.enqueue('T','Hello');o.close()
  def f(*args):raise RuntimeError('offline')
  r=verify_github(self.db,'T','owner/repo',40,'key','publisher',f)
  self.assertEqual(r['status'],'READ_FAILED');self.assertTrue(r['no_retry'])
 def test_missing_token(self):
  self.assertEqual(verify_github(self.db,'T','owner/repo',40,'','publisher')['status'],'BLOCKED_READ_CREDENTIALS')
if __name__=='__main__':unittest.main()
