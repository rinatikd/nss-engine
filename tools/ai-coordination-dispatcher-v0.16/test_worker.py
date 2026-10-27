import json, os, tempfile, unittest
from pathlib import Path
from worker import process

class WorkerTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.root=Path(self.tmp.name);self.queue=self.root/'queue';self.queue.mkdir();self.db=str(self.root/'jobs.db')
 def put(self,name,data):
  (self.queue/name).write_text(json.dumps(data),encoding='utf-8')
 def test_once_and_dedup(self):
  self.put('a.json',{'task_id':'task-1','prompt':'review source only'})
  r=process(self.queue,self.db);self.assertEqual(r[0]['state'],'RESPONDED')
  r2=process(self.queue,self.db);self.assertEqual(r2[0]['claim']['status'],'duplicate');self.assertFalse(r2[0]['sent'])
 def test_conflicting_id(self):
  self.put('a.json',{'task_id':'task-1','prompt':'A'})
  process(self.queue,self.db)
  self.put('a.json',{'task_id':'task-1','prompt':'B'})
  self.assertEqual(process(self.queue,self.db)[0]['claim']['status'],'conflict')
 def test_reject_invalid(self):
  self.put('a.json',{'task_id':'../../escape','prompt':'hello'})
  self.assertEqual(process(self.queue,self.db)[0]['state'],'REJECTED')
 def test_publish_mock_prohibited(self):
  with self.assertRaises(ValueError):process(self.queue,self.db,publish=True)
 def test_queue_batch_limit(self):
  for i in range(3):self.put(f'{i}.json',{'task_id':f'task-{i}','prompt':'A'})
  self.assertEqual(len(process(self.queue,self.db,max_tasks=2)),2)
 def test_no_secret_live(self):
  old=os.environ.pop('AI_LEDGER_HMAC_KEY',None)
  try:
   with self.assertRaises(ValueError):process(self.queue,self.db,live=True)
  finally:
   if old is not None:os.environ['AI_LEDGER_HMAC_KEY']=old

if __name__=='__main__':unittest.main()
