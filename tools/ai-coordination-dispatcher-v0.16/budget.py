"""Atomic invocation quota for optional live provider use; not a price guarantee."""
import sqlite3,time
class Budget:
 def __init__(self,db):
  self.db=sqlite3.connect(db,timeout=15,isolation_level=None)
  self.db.execute('PRAGMA journal_mode=WAL');self.db.execute('PRAGMA busy_timeout=15000')
  self.db.execute('CREATE TABLE IF NOT EXISTS provider_quota (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, planned_tokens INTEGER NOT NULL)')
 def reserve(self,max_calls,max_planned_tokens,planned_tokens):
  if max_calls<1 or max_planned_tokens<1 or planned_tokens<1:return False
  day=time.strftime('%Y-%m-%d',time.gmtime())
  self.db.execute('BEGIN IMMEDIATE')
  try:
   row=self.db.execute('SELECT calls,planned_tokens FROM provider_quota WHERE day=?',(day,)).fetchone() or (0,0)
   ok=row[0]+1<=max_calls and row[1]+planned_tokens<=max_planned_tokens
   if ok:self.db.execute('INSERT INTO provider_quota VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET calls=excluded.calls, planned_tokens=excluded.planned_tokens',(day,row[0]+1,row[1]+planned_tokens))
   self.db.execute('COMMIT');return ok
  except BaseException:self.db.execute('ROLLBACK');raise
 def close(self):self.db.close()
