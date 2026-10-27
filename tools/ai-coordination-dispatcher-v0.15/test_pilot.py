import os,tempfile,unittest
from unittest.mock import patch
from pathlib import Path
from pilot import pilot
from outbox import Outbox

class PilotTests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.db=str(Path(self.t.name)/'state.sqlite')
 def tearDown(self):self.t.cleanup()
 def test_mock_does_not_publish(self):
  r=pilot(self.db,'p001','Please review these source files')
  self.assertEqual(r['status'],'DRY_RUN');self.assertFalse(r['outbox_enqueued'])
  o=Outbox(self.db);self.assertIsNone(o.get('p001'));o.close()
 def test_duplicate_does_not_invoke_again(self):
  self.assertEqual(pilot(self.db,'p001','text')['status'],'DRY_RUN')
  r=pilot(self.db,'p001','text');self.assertNotEqual(r['status'],'DRY_RUN')
 def test_same_id_changed_text_conflict(self):
  pilot(self.db,'p001','text');r=pilot(self.db,'p001','different')
  self.assertEqual(r['detail']['claim']['status'],'conflict')
 def test_live_without_secrets_blocks_before_call(self):
  with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'','AI_LEDGER_HMAC_KEY':''}):
   r=pilot(self.db,'p001','text',live=True)
  self.assertEqual(r['status'],'BLOCKED');self.assertFalse(r['api_invoked'])
 def test_bad_prompt_rejected(self):
  with self.assertRaises(ValueError):pilot(self.db,'p001','  ')
 def test_authenticated_live_response_stages_once(self):
  fake={'task_id':'p001','state':'RESPONDED','invocation_id':'msg_mocked','provider':'claude','authenticated':True,'response':'example independent model output'}
  with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'mock','AI_LEDGER_HMAC_KEY':'x'*40}),patch('pilot.run',return_value=fake):
   r=pilot(self.db,'p001','text',live=True)
  self.assertEqual(r['status'],'STAGED');self.assertFalse(r['published'])
  o=Outbox(self.db);self.assertEqual(o.get('p001')['state'],'PENDING');o.close()
 def test_error_unknown_never_stages(self):
  with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'mock','AI_LEDGER_HMAC_KEY':'x'*40}),patch('pilot.run',return_value={'task_id':'p001','state':'UNKNOWN'}):
   r=pilot(self.db,'p001','text',live=True)
  self.assertEqual(r['status'],'UNKNOWN')
  o=Outbox(self.db);self.assertIsNone(o.get('p001'));o.close()

if __name__=='__main__':unittest.main()
