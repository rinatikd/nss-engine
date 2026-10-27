import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from pilot_v13 import preflight,run_pilot

class V13Tests(unittest.TestCase):
    def test_preflight_empty_is_blocked(self):
        r=preflight({},live=True)
        self.assertFalse(r['ready'])
        self.assertFalse(any(r['checks'].values()))
    def test_preflight_requires_both_approvals(self):
        e={'AI_LEDGER_HMAC_KEY':'x'*40,'ANTHROPIC_API_KEY':'y'*40,
           'GITHUB_TOKEN':'z'*40,'GITHUB_REPOSITORY':'rinatikd/nss-engine',
           'GITHUB_ISSUE_NUMBER':'40', 'AI_MAX_CALLS_PER_DAY':'1',
           'AI_MAX_PLANNED_TOKENS_PER_DAY':'2000',
           'AI_APPROVE_REAL_REQUEST':'YES_I_APPROVE_ONE_PAID_CLAUDE_REQUEST'}
        self.assertFalse(preflight(e,True)['ready'])
        e['AI_APPROVE_GITHUB_WRITE']='YES_I_APPROVE_GITHUB_ISSUE_WRITE'
        report=preflight(e,True)
        self.assertFalse(report['ready'])
        self.assertFalse(report['checks']['paid_api_policy'])
    def test_wrong_target_rejected(self):
        e={'GITHUB_REPOSITORY':'http://bad/../../path','GITHUB_ISSUE_NUMBER':'40'}
        self.assertFalse(preflight(e,True)['checks']['github_target'])
    def test_live_missing_keys_no_dispatch(self):
        with patch('pilot_v13.pilot', side_effect=AssertionError('called')):
            with tempfile.TemporaryDirectory() as d:
                result=run_pilot(str(Path(d)/'state.sqlite'),'t001','example',live=True,env={})
        self.assertEqual(result['state'],'BLOCKED_PRECHECK')
        self.assertFalse(result['provider_invoked'])
    def test_mock_succeeds_without_keys(self):
        with tempfile.TemporaryDirectory() as d:
            result=run_pilot(str(Path(d)/'state.sqlite'),'t002','example',live=False,env={})
        self.assertEqual(result['state'],'DRY_RUN')
        self.assertFalse(result['github_published'])
    def test_duplicate_mock_never_reinvokes(self):
        with tempfile.TemporaryDirectory() as d:
            db=str(Path(d)/'state.sqlite')
            first=run_pilot(db,'t003','hello',env={})
            second=run_pilot(db,'t003','hello',env={})
        self.assertEqual(first['state'],'DRY_RUN')
        self.assertNotEqual(second['state'],'DRY_RUN')
    def test_utf8_bom_prompt_file(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'prompt.txt';path.write_bytes(b'\xef\xbb\xbfHello')
            self.assertEqual(path.read_text(encoding='utf-8-sig'),'Hello')

if __name__=='__main__': unittest.main()
