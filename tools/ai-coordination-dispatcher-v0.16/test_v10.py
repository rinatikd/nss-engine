import os, tempfile, unittest
from unittest.mock import patch
from pathlib import Path
from ai_reviewer import read_input, assess

class Version10Tests(unittest.TestCase):
    def test_auto_utf8_bom(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'x.txt';p.write_bytes(b'\xef\xbb\xbf'+ 'Ответ'.encode())
            self.assertEqual(read_input(p),'Ответ')
    def test_auto_utf16(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'x.txt';p.write_bytes('Ответ'.encode('utf-16'))
            self.assertEqual(read_input(p),'Ответ')
    def test_cp1251_explicit(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'x.txt';p.write_bytes('Ответ'.encode('cp1251'))
            with self.assertRaisesRegex(ValueError,'not UTF-8'):read_input(p)
            self.assertEqual(read_input(p,'cp1251'),'Ответ')
    def test_live_without_budget_blocks_before_invocation(self):
        with tempfile.TemporaryDirectory() as d:
            with patch.dict(os.environ,{'AI_REVIEW_LIVE_APPROVED':'YES','AI_REVIEW_MAX_CALLS_PER_DAY':'0'},clear=True):
                with patch('ai_reviewer.invoke') as inv:
                    res=assess(str(Path(d)/'s.db'),'r1','answer','rubric',live=True)
                    self.assertEqual(res['reason'],'reviewer budget cap');inv.assert_not_called()
    def test_live_reserved_once_and_failure_is_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            env={'AI_REVIEW_LIVE_APPROVED':'YES','AI_REVIEW_MAX_CALLS_PER_DAY':'1','AI_REVIEW_MAX_PLANNED_TOKENS_PER_DAY':'10000'}
            with patch.dict(os.environ,env):
                with patch('ai_reviewer.invoke',side_effect=RuntimeError('transport')) as inv:
                    one=assess(str(Path(d)/'s.db'),'r1','answer','rubric',live=True)
                    two=assess(str(Path(d)/'s.db'),'r1','answer','rubric',live=True)
                    self.assertEqual(one['state'],'UNKNOWN')
                    self.assertEqual(two['state'],'ALREADY_ATTEMPTED');self.assertEqual(inv.call_count,1)
    def test_budget_cannot_be_bypassed_by_different_id(self):
        with tempfile.TemporaryDirectory() as d:
            env={'AI_REVIEW_LIVE_APPROVED':'YES','AI_REVIEW_MAX_CALLS_PER_DAY':'1','AI_REVIEW_MAX_PLANNED_TOKENS_PER_DAY':'10000'}
            with patch.dict(os.environ,env):
                with patch('ai_reviewer.invoke',side_effect=RuntimeError('transport')) as inv:
                    assess(str(Path(d)/'s.db'),'r1','answer','rubric',live=True)
                    nxt=assess(str(Path(d)/'s.db'),'r2','answer','rubric',live=True)
                    self.assertEqual(nxt['reason'],'reviewer budget cap');self.assertEqual(inv.call_count,1)

if __name__=='__main__':unittest.main()
