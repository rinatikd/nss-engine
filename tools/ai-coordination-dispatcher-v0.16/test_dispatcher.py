import os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from ledger import Ledger
from dispatcher import run, UnknownDelivery
SECRET=b'0'*40
class TestDispatcher(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.db=str(Path(self.tmp.name)/'a.db')
 def test_mock_replay(self):
  a=run(self.db,SECRET,'001','hello');self.assertEqual(a['state'],'RESPONDED');self.assertFalse(a['authenticated'])
  b=run(self.db,SECRET,'001','hello');self.assertFalse(b['sent']);self.assertEqual(b['claim']['state'],'RESPONDED')
 def test_conflict(self):
  run(self.db,SECRET,'001','hello')
  self.assertEqual(run(self.db,SECRET,'001','different')['claim']['status'],'conflict')
 def test_live_key_required_before_dispatch(self):
  with patch.dict(os.environ,{'ANTHROPIC_API_KEY':''}):
   a=run(self.db,SECRET,'002','hello',live=True)
  self.assertEqual(a['state'],'CANCELLED')
 def test_unknown_stops_retry(self):
  with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'synthetic-test-placeholder','AI_MAX_CALLS_PER_DAY':'2','AI_MAX_PLANNED_TOKENS_PER_DAY':'2000'}):
   with patch('dispatcher.invoke',side_effect=UnknownDelivery('simulated timeout')):
    a=run(self.db,SECRET,'003','hello',live=True)
  self.assertEqual(a['state'],'UNKNOWN')
  self.assertEqual(run(self.db,SECRET,'003','hello',live=True)['claim']['state'],'UNKNOWN')
 def test_publishing_needs_live(self):
  with self.assertRaises(ValueError):run(self.db,SECRET,'004','hello',publish=True)
if __name__=='__main__':unittest.main()
