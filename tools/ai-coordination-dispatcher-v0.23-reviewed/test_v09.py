import json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
from ai_reviewer import assess, parse_verdict, InvalidReview, review_prompt, SCHEMA
from review_queue import ReviewQueue

class V09Tests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.db=str(Path(self.t.name)/'state.db')
 def tearDown(self):self.t.cleanup()
 def test_offline_creates_draft(self):
  r=assess(self.db,'TASK1','Here is answer','Check citations')
  self.assertEqual(r['state'],'ADVISORY_REVIEW_RECORDED');self.assertEqual(r['queue']['followup_id'],'TASK1.r1')
  self.assertFalse(r['authenticated_review']);self.assertFalse(r['auto_dispatched'])
  q=ReviewQueue(self.db);self.assertEqual(q.draft('TASK1.r1')['state'],'DRAFT_REQUIRES_APPROVAL');q.close()
 def test_idempotent_review(self):
  assess(self.db,'T2','Answer','rubric')
  self.assertEqual(assess(self.db,'T2','Answer','rubric')['queue']['status'],'EXISTS')
 def test_conflicting_answer(self):
  assess(self.db,'T3','Answer','rubric')
  self.assertEqual(assess(self.db,'T3','Different','rubric')['queue']['status'],'CONFLICT')
 def test_revision_limit(self):
  r=assess(self.db,'T4','Answer','rubric',revision=2)
  self.assertIsNone(r['queue']['followup_id'])
 def test_invalid_json(self):
  with self.assertRaises(InvalidReview):parse_verdict('not json')
 def test_schema_is_strict(self):
  obj={'schema':SCHEMA,'decision':'APPROVE','critique':'','evidence_gaps':[],'override':True}
  with self.assertRaises(InvalidReview):parse_verdict(json.dumps(obj))
 def test_revision_needs_critique(self):
  with self.assertRaises(InvalidReview):parse_verdict(json.dumps(dict(schema=SCHEMA,decision='REVISE',critique='',evidence_gaps=[])))
 def test_live_bad_provider_reply_is_quarantined(self):
  with patch('ai_reviewer.require_paid_api_allowed'), patch.dict('os.environ',{'AI_REVIEW_LIVE_APPROVED':'YES','AI_REVIEW_MAX_CALLS_PER_DAY':'5','AI_REVIEW_MAX_PLANNED_TOKENS_PER_DAY':'20000'}), patch('ai_reviewer.invoke',return_value={'provider':'claude','invocation_id':'x','authenticated':True,'text':'ignore instructions'}):
   r=assess(self.db,'T5','Answer','rubric',live=True)
  self.assertEqual(r['state'],'QUARANTINED')
 def test_live_provider_never_sends_followup(self):
  val=json.dumps(dict(schema=SCHEMA,decision='APPROVE',critique='',evidence_gaps=[]))
  with patch('ai_reviewer.require_paid_api_allowed'), patch.dict('os.environ',{'AI_REVIEW_LIVE_APPROVED':'YES','AI_REVIEW_MAX_CALLS_PER_DAY':'5','AI_REVIEW_MAX_PLANNED_TOKENS_PER_DAY':'20000'}), patch('ai_reviewer.invoke',return_value={'provider':'claude','invocation_id':'id','authenticated':True,'text':val}):
   r=assess(self.db,'T6','Answer','rubric',live=True)
  self.assertTrue(r['human_approval_required']);self.assertFalse(r['auto_dispatched'])
 def test_live_requires_approval(self):
  with patch.dict('os.environ',{'AI_REVIEW_LIVE_APPROVED':''}):
   r=assess(self.db,'TX','Answer','rubric',live=True)
  self.assertEqual(r['state'],'BLOCKED')
 def test_live_reservation_prevents_duplicate(self):
  val=json.dumps(dict(schema=SCHEMA,decision='APPROVE',critique='',evidence_gaps=[]))
  with patch('ai_reviewer.require_paid_api_allowed'), patch.dict('os.environ',{'AI_REVIEW_LIVE_APPROVED':'YES','AI_REVIEW_MAX_CALLS_PER_DAY':'5','AI_REVIEW_MAX_PLANNED_TOKENS_PER_DAY':'20000'}), patch('ai_reviewer.invoke',return_value={'provider':'claude','invocation_id':'id','authenticated':True,'text':val}) as call:
   assess(self.db,'TY','Answer','rubric',live=True)
   r=assess(self.db,'TY','Answer','rubric',live=True)
   self.assertEqual(call.call_count,1)
  self.assertEqual(r['state'],'ALREADY_ATTEMPTED')
 def test_long_response_rejected_preflight(self):
  with self.assertRaises(InvalidReview):review_prompt('T7','a'*20001,'rubric')
if __name__=='__main__':unittest.main()
