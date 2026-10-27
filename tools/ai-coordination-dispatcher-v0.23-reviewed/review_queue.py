"""Persistent human-review gate for feedback and correction drafts. No provider calls or posting."""
import argparse, hashlib, json, re, sqlite3, time
from pathlib import Path

TASK_ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')
DECISIONS=('APPROVE','REVISE','REJECT')

class ReviewQueue:
 def __init__(self,db):
  self.db=sqlite3.connect(str(Path(db)),timeout=15,isolation_level=None)
  self.db.execute('PRAGMA journal_mode=WAL')
  self.db.execute('PRAGMA synchronous=FULL')
  self.db.execute('PRAGMA busy_timeout=15000')
  self.db.execute('''CREATE TABLE IF NOT EXISTS review_decisions (
    task_id TEXT PRIMARY KEY, response_sha256 TEXT NOT NULL,
    decision TEXT NOT NULL, critique TEXT NOT NULL,
    revision INTEGER NOT NULL, followup_id TEXT,
    created REAL NOT NULL)''')
  self.db.execute('''CREATE TABLE IF NOT EXISTS followup_drafts (
    task_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL,
    revision INTEGER NOT NULL, prompt TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state='DRAFT_REQUIRES_APPROVAL'),
    created REAL NOT NULL)''')
 def close(self):self.db.close()
 def decide(self, task_id, response, decision, critique='', revision=0, max_revisions=2):
  if not isinstance(task_id,str) or not TASK_ID.fullmatch(task_id):raise ValueError('invalid task id')
  if not isinstance(response,str) or not response.strip() or len(response)>20000:raise ValueError('invalid response')
  if decision not in DECISIONS:raise ValueError('invalid decision')
  if not isinstance(critique,str) or len(critique)>1500:raise ValueError('invalid critique')
  if not isinstance(revision,int) or not 0<=revision<=max_revisions<=2:raise ValueError('invalid revision budget')
  if decision=='REVISE' and not critique.strip():raise ValueError('revision requires critique')
  digest=hashlib.sha256(response.encode()).hexdigest()
  followup_id=f'{task_id}.r{revision+1}' if decision=='REVISE' and revision<max_revisions else None
  if followup_id and not TASK_ID.fullmatch(followup_id):raise ValueError('followup id too long')
  prompt=(f'Correct the prior answer for task {task_id}. Previous answer SHA-256: {digest}. '
          f'Issues to address: {critique}\nDo not assume execution or deployment; provide evidence.') if followup_id else None
  self.db.execute('BEGIN IMMEDIATE')
  try:
   old=self.db.execute('SELECT response_sha256,decision,critique,revision,followup_id FROM review_decisions WHERE task_id=?',(task_id,)).fetchone()
   expected=(digest,decision,critique,revision,followup_id)
   if old:
    result={'status':'EXISTS' if old==expected else 'CONFLICT','followup_id':old[4]}
   else:
    now=time.time()
    self.db.execute('INSERT INTO review_decisions VALUES (?,?,?,?,?,?,?)',(task_id,digest,decision,critique,revision,followup_id,now))
    if followup_id:
     self.db.execute('INSERT INTO followup_drafts VALUES (?,?,?,?,?,?)',(followup_id,task_id,revision+1,prompt,'DRAFT_REQUIRES_APPROVAL',now))
    result={'status':'RECORDED','decision':decision,'followup_id':followup_id,'auto_dispatched':False}
   self.db.execute('COMMIT');return result
  except BaseException:
   self.db.execute('ROLLBACK');raise
 def draft(self,task_id):
  row=self.db.execute('SELECT task_id,parent_id,revision,prompt,state FROM followup_drafts WHERE task_id=?',(task_id,)).fetchone()
  return dict(zip(('task_id','parent_id','revision','prompt','state'),row)) if row else None

def main():
 p=argparse.ArgumentParser();p.add_argument('--db',required=True);p.add_argument('--task-id',required=True)
 p.add_argument('--response-file',required=True);p.add_argument('--decision',choices=DECISIONS,required=True)
 p.add_argument('--critique',default='');p.add_argument('--revision',type=int,default=0)
 a=p.parse_args();q=ReviewQueue(a.db)
 try:print(json.dumps(q.decide(a.task_id,Path(a.response_file).read_text(encoding='utf-8'),a.decision,a.critique,a.revision),ensure_ascii=False,indent=2))
 finally:q.close()
if __name__=='__main__':main()
