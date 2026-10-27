"""Source-only, stdlib SQLite dispatcher ledger prototype. Does NOT invoke models."""
import hashlib, hmac, json, os, secrets, sqlite3, time
from pathlib import Path

class Ledger:
    def __init__(self, path, secret):
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise ValueError('Use a random >=32-byte secret from an external secure store')
        self.path = str(Path(path))
        self.secret = secret
        self.db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA busy_timeout=10000')
        self.db.execute('''CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
          owner TEXT, token TEXT, deadline REAL, revision INTEGER NOT NULL DEFAULT 0,
          updated REAL NOT NULL, result TEXT)''')

    def close(self): self.db.close()

    def fingerprint(self, payload):
        canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        return hmac.new(self.secret, canonical.encode(), hashlib.sha256).hexdigest()

    def _txn(self, fn):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            result = fn()
            self.db.execute('COMMIT')
            return result
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def claim(self, task_id, payload, owner, ttl=60):
        if not task_id or not owner or ttl <= 0: raise ValueError('invalid claim')
        fp=self.fingerprint(payload)
        now=time.time()
        def act():
            row=self.db.execute('SELECT fingerprint,state,owner,deadline FROM tasks WHERE id=?',(task_id,)).fetchone()
            if row:
                if not hmac.compare_digest(row[0],fp): return {'status':'conflict','state':row[1]}
                if row[3] is not None and row[3] < now and row[1] in ('CLAIMED','DISPATCHING'):
                    self.db.execute("UPDATE tasks SET state='UNKNOWN',revision=revision+1,updated=? WHERE id=?",(now,task_id))
                    return {'status':'duplicate','state':'UNKNOWN'}
                return {'status':'duplicate','state':row[1]}
            token=secrets.token_hex(24)
            self.db.execute('INSERT INTO tasks (id,fingerprint,state,owner,token,deadline,updated) VALUES (?,?,?,?,?,?,?)',
                            (task_id,fp,'CLAIMED',owner,token,now+ttl,now))
            return {'status':'created','state':'CLAIMED','token':token}
        return self._txn(act)

    def transition(self, task_id, token, expected, new_state, result=None):
        allowed={'CLAIMED': {'DISPATCHING','CANCELLED'},'DISPATCHING':{'UNKNOWN','RESPONDED','NOT_PERFORMED'},
                 'UNKNOWN':{'RESOLVED_NOT_PERFORMED','RESOLVED_CONFIRMED'},'RESPONDED':{'VERIFIED','REJECTED'},
                 'VERIFIED':{'CLOSED'}}
        if new_state not in allowed.get(expected,set()): raise ValueError('transition forbidden')
        def act():
            row=self.db.execute('SELECT state,token FROM tasks WHERE id=?',(task_id,)).fetchone()
            if row is None or not hmac.compare_digest(row[1] or '',token): return False
            if row[0] != expected: return False
            self.db.execute('UPDATE tasks SET state=?,result=?,revision=revision+1,updated=? WHERE id=?',
                            (new_state,json.dumps(result) if result is not None else None,time.time(),task_id))
            return True
        return self._txn(act)

    def get(self, task_id):
        row=self.db.execute('SELECT id,state,owner,deadline,revision,result FROM tasks WHERE id=?',(task_id,)).fetchone()
        return dict(zip(['id','state','owner','deadline','revision','result'],row)) if row else None

    def recover_expired(self):
        now=time.time()
        def act():
            cur=self.db.execute("UPDATE tasks SET state='UNKNOWN', revision=revision+1,updated=? WHERE state IN ('CLAIMED','DISPATCHING') AND deadline<?",(now,now))
            return cur.rowcount
        return self._txn(act)
