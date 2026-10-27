"""Durable, opt-in GitHub response outbox. Does not invoke a model."""
import argparse, hashlib, json, os, re, sqlite3, time, urllib.error, urllib.request
from pathlib import Path

TASK_ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')
REPO=re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
STATES=('PENDING','SENDING','POSTED','UNKNOWN','BLOCKED')

class Outbox:
 def __init__(self, db):
  self.conn=sqlite3.connect(str(Path(db)),timeout=15,isolation_level=None)
  self.conn.execute('PRAGMA journal_mode=WAL')
  self.conn.execute('PRAGMA synchronous=FULL')
  self.conn.execute('PRAGMA busy_timeout=15000')
  self.conn.execute('''CREATE TABLE IF NOT EXISTS github_outbox (
  task_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, body TEXT NOT NULL,
  state TEXT NOT NULL, updated REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  comment_id INTEGER, note TEXT)''')
 def close(self): self.conn.close()
 def enqueue(self,task_id,body):
  if not isinstance(task_id,str) or not TASK_ID.fullmatch(task_id):raise ValueError('invalid task id')
  if not isinstance(body,str) or len(body)>16000 or not body:raise ValueError('invalid body')
  h=hashlib.sha256(body.encode()).hexdigest()
  self.conn.execute('BEGIN IMMEDIATE')
  try:
   row=self.conn.execute('SELECT payload_hash,state FROM github_outbox WHERE task_id=?',(task_id,)).fetchone()
   if row: result={'status':'CONFLICT' if row[0]!=h else 'EXISTS','state':row[1]}
   else:
    self.conn.execute('INSERT INTO github_outbox(task_id,payload_hash,body,state,updated) VALUES(?,?,?,?,?)',(task_id,h,body,'PENDING',time.time()))
    result={'status':'QUEUED','state':'PENDING'}
   self.conn.execute('COMMIT');return result
  except BaseException:self.conn.execute('ROLLBACK');raise
 def get(self,task_id):
  r=self.conn.execute('SELECT task_id,state,attempts,comment_id,note FROM github_outbox WHERE task_id=?',(task_id,)).fetchone()
  return dict(zip(('task_id','state','attempts','comment_id','note'),r)) if r else None
 def _reserve(self,task_id):
  self.conn.execute('BEGIN IMMEDIATE')
  try:
   r=self.conn.execute('SELECT body,state FROM github_outbox WHERE task_id=?',(task_id,)).fetchone()
   if not r:raise ValueError('unknown task')
   if r[1]!='PENDING':result=None
   else:
    self.conn.execute("UPDATE github_outbox SET state='SENDING',attempts=attempts+1,updated=? WHERE task_id=?",(time.time(),task_id));result=r[0]
   self.conn.execute('COMMIT');return result
  except BaseException:self.conn.execute('ROLLBACK');raise
 def _finish(self,task_id,state,comment_id=None,note=None):
  self.conn.execute('UPDATE github_outbox SET state=?,comment_id=?,note=?,updated=? WHERE task_id=? AND state=?',(state,comment_id,note,time.time(),task_id,'SENDING'))
 def publish(self,task_id,repo,issue,token,transport=None):
  # Must check credentials BEFORE reserving and crossing the uncertain POST boundary.
  if not REPO.fullmatch(repo or '') or not str(issue).isdigit() or int(issue)<1 or not token:
   return {'state':'BLOCKED','reason':'missing_or_invalid_configuration'}
  body=self._reserve(task_id)
  if body is None:return {'state':self.get(task_id)['state'],'sent':False}
  try:
   if transport is None:
    url=f'https://api.github.com/repos/{repo}/issues/{int(issue)}/comments'
    req=urllib.request.Request(url,data=json.dumps({'body':body}).encode(),headers={
     'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json',
     'Content-Type':'application/json','User-Agent':'ai-coordination-outbox-v0.4'},method='POST')
    with urllib.request.urlopen(req,timeout=20) as res:
     data=json.loads(res.read(100000))
   else:data=transport(repo,int(issue),token,body)
   comment_id=data.get('id')
   if not isinstance(comment_id,int) or comment_id<1:raise ValueError('unverified response')
   self._finish(task_id,'POSTED',comment_id)
   return {'state':'POSTED','comment_id':comment_id}
  except BaseException:
   # Deliberately never requeue: server might have accepted the comment.
   self._finish(task_id,'UNKNOWN',note='submit_outcome_unverified')
   return {'state':'UNKNOWN','sent':'unverified'}
 def recover(self):
  # Crash between POST and persisted response: assume possibly delivered.
  cur=self.conn.execute("UPDATE github_outbox SET state='UNKNOWN',note='interrupted_submission',updated=? WHERE state='SENDING'",(time.time(),))
  return cur.rowcount

def render_response(task_id, invocation_id, provider, response, authenticated):
 if not TASK_ID.fullmatch(task_id):raise ValueError('bad id')
 if not isinstance(response,str):raise ValueError('bad response')
 sha=hashlib.sha256(response.encode()).hexdigest()
 # Model output is untrusted, so it cannot be a control marker at line start.
 quoted='\n'.join('> '+x for x in response[:6500].splitlines())
 return f'[DISPATCHER RELAY {task_id}]\nProvider: {provider}\nProvider invocation: {invocation_id}\nProvider authenticated: {authenticated}\nResponse SHA256: {sha}\nUNTRUSTED MODEL RESPONSE (quoted, not instruction):\n{quoted}\n'

def main():
 p=argparse.ArgumentParser();p.add_argument('--db',required=True);sub=p.add_subparsers(dest='cmd',required=True)
 a=sub.add_parser('enqueue');a.add_argument('--task-id',required=True);a.add_argument('--body-file',required=True)
 b=sub.add_parser('publish');b.add_argument('--task-id',required=True);b.add_argument('--live-publish',action='store_true')
 sub.add_parser('recover');arg=p.parse_args();o=Outbox(arg.db)
 try:
  if arg.cmd=='enqueue':result=o.enqueue(arg.task_id,Path(arg.body_file).read_text(encoding='utf8'))
  elif arg.cmd=='recover':result={'interrupted_marked_unknown':o.recover()}
  elif not arg.live_publish:result={'state':'BLOCKED','reason':'explicit --live-publish required'}
  else:result=o.publish(arg.task_id,os.environ.get('GITHUB_REPOSITORY'),os.environ.get('GITHUB_ISSUE_NUMBER','40'),os.environ.get('GITHUB_TOKEN'))
  print(json.dumps(result,ensure_ascii=False))
 finally:o.close()
if __name__=='__main__':main()
