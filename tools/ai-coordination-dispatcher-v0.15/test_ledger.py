import multiprocessing as mp
import os, sqlite3, tempfile, time, unittest
from pathlib import Path
from ledger import Ledger
SECRET=b'local-test-secret-' + b'x'*32

def worker(db,q,start):
    x=Ledger(db,SECRET)
    start.wait()
    q.put(x.claim('one',{'prompt':'A'},str(os.getpid())))
    x.close()

class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=str(Path(self.tmp.name)/'ledger.sqlite')
        self.x=Ledger(self.path,SECRET);self.addCleanup(self.x.close)

    def test_claim_conflict_and_replay(self):
        a=self.x.claim('one',{'prompt':'A'},'a');self.assertEqual(a['status'],'created')
        self.assertEqual(self.x.claim('one',{'prompt':'A'},'b')['status'],'duplicate')
        self.assertEqual(self.x.claim('one',{'prompt':'B'},'b')['status'],'conflict')

    def test_multiprocess_atomic_claim(self):
        q=mp.Queue(); gate=mp.Event()
        ps=[mp.Process(target=worker,args=(self.path,q,gate)) for _ in range(8)]
        for p in ps:p.start()
        gate.set();out=[q.get(timeout=12) for _ in ps]
        for p in ps:p.join(12);self.assertEqual(p.exitcode,0)
        self.assertEqual(sum(x['status']=='created' for x in out),1)
        self.assertEqual(sum(x['status']=='duplicate' for x in out),7)

    def test_unknown_survives_restart_and_refuses_retry(self):
        a=self.x.claim('one',{'prompt':'A'},'a')
        self.assertTrue(self.x.transition('one',a['token'],'CLAIMED','DISPATCHING'))
        self.assertTrue(self.x.transition('one',a['token'],'DISPATCHING','UNKNOWN'))
        y=Ledger(self.path,SECRET)
        try:
            self.assertEqual(y.claim('one',{'prompt':'A'},'different')['state'],'UNKNOWN')
            self.assertFalse(y.transition('one','invalid','UNKNOWN','RESOLVED_NOT_PERFORMED'))
        finally:y.close()

    def test_expiry_fails_closed(self):
        self.x.claim('one',{'prompt':'A'},'a',ttl=.01)
        time.sleep(.025)
        self.assertEqual(self.x.recover_expired(),1)
        self.assertEqual(self.x.get('one')['state'],'UNKNOWN')
        self.assertEqual(self.x.claim('one',{'prompt':'A'},'b')['state'],'UNKNOWN')

    def test_crash_during_transaction_rolls_back(self):
        a=self.x.claim('one',{'prompt':'A'},'a')
        try:
            self.x._txn(lambda: (self.x.db.execute("UPDATE tasks SET state='RESPONDED' WHERE id='one'"), 1/0))
        except ZeroDivisionError:pass
        self.assertEqual(self.x.get('one')['state'],'CLAIMED')

    def test_unrelated_rows_no_lost_updates(self):
        for i in range(30):self.assertEqual(self.x.claim(str(i),{'i':i},'a')['status'],'created')
        self.assertEqual(self.x.db.execute('SELECT COUNT(*) FROM tasks').fetchone()[0],30)

    def test_old_record_orphan_tmp_does_not_block(self):
        Path(self.tmp.name,'ledger.sqlite.tmp').write_text('orphan')
        self.assertEqual(self.x.claim('one',{'prompt':'A'},'a')['status'],'created')

if __name__=='__main__':unittest.main(verbosity=2)
