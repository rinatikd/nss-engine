"""Offline review contract checks; synthetic verdicts are not provider evidence."""
import json
from pathlib import Path
import tempfile
import unittest

import ai_reviewer
from orchestrator import MockAgent, Store, canonical, step


class ReviewContractTests(unittest.TestCase):
    def verdict(self, decision='APPROVE', blocking=None, recommendations=None):
        return dict(schema='ai-review-verdict/v2', decision=decision, critique='Review explanation',
                    blocking_issues=blocking or [], recommendations=recommendations or [])

    def test_v2_approval_accepts_recommendations(self):
        value = self.verdict(recommendations=['Use 86.40 GB for consistent formatting'])
        self.assertEqual(ai_reviewer.parse_verdict(canonical(value)), value)
        self.assertEqual(ai_reviewer.review_findings(value), dict(
            blocking_issues=[], recommendations=value['recommendations']))

    def test_v2_approval_cannot_override_explicit_blockers(self):
        value = self.verdict(blocking=['The calculated capacity is wrong'])
        with self.assertRaises(ai_reviewer.InvalidReview):
            ai_reviewer.parse_verdict(canonical(value))

    def test_v2_revision_requires_blocking_reason(self):
        for decision in ('REVISE', 'REJECT'):
            with self.subTest(decision=decision), self.assertRaises(ai_reviewer.InvalidReview):
                ai_reviewer.parse_verdict(canonical(self.verdict(decision=decision)))

    def test_v2_finding_fields_are_strict(self):
        invalid = [None, 'remark', [''], ['x' * 301], ['a'] * 6, [False]]
        for field in ('blocking_issues', 'recommendations'):
            for value in invalid:
                verdict = self.verdict(decision='REVISE', blocking=['Wrong result'])
                verdict[field] = value
                with self.subTest(field=field, value=value), self.assertRaises(ai_reviewer.InvalidReview):
                    ai_reviewer.parse_verdict(canonical(verdict))
        verdict = self.verdict()
        verdict['extra'] = 'not permitted'
        with self.assertRaises(ai_reviewer.InvalidReview):
            ai_reviewer.parse_verdict(canonical(verdict))

    def test_legacy_approval_preserves_observations(self):
        verdict = dict(schema=ai_reviewer.SCHEMA, decision='APPROVE', critique='Correct result',
                       evidence_gaps=['Decimal precision could be more explicit'])
        parsed = ai_reviewer.parse_verdict(canonical(verdict))
        self.assertEqual(parsed, verdict)
        self.assertEqual(ai_reviewer.review_findings(parsed), dict(
            blocking_issues=[], recommendations=verdict['evidence_gaps']))

    def test_legacy_revision_gaps_remain_blocking(self):
        verdict = dict(schema=ai_reviewer.SCHEMA, decision='REVISE', critique='Fix calculation',
                       evidence_gaps=['Incorrect decimal capacity'])
        parsed = ai_reviewer.parse_verdict(canonical(verdict))
        self.assertEqual(ai_reviewer.review_findings(parsed), dict(
            blocking_issues=verdict['evidence_gaps'], recommendations=[]))

    def finish_review(self, store, verdict, agents):
        step(store, agents)
        call = store.reserve('mock', agents)
        reply = agents['reviewer'].invoke(call)
        reply['text'] = canonical(verdict)
        return store.finish(call, reply)

    def test_nonblocking_approval_completes_without_retry_and_keeps_findings(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(str(Path(directory) / 'state.sqlite'))
            agents = {role: MockAgent(role) for role in ('executor', 'reviewer')}
            try:
                store.submit('math', 'Compute camera capacity', 'Correct decimal GB')
                verdict = self.verdict(recommendations=['Use two decimals'])
                self.assertEqual(self.finish_review(store, verdict, agents)['state'], 'COMPLETED')
                task = store.status('math')
                self.assertEqual(task['revision'], 0)
                self.assertEqual(json.loads(task['critique'])['recommendations'], ['Use two decimals'])
                self.assertEqual(json.loads(task['attempts'][-1]['result']['text']), verdict)
                self.assertFalse(task['human_accepted'])
                self.assertFalse(task['github_published'])
                self.assertEqual(step(store, agents)['state'], 'IDLE')
            finally:
                store.close()

    def test_blocking_revision_is_scheduled_and_distinguished_from_recommendations(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(str(Path(directory) / 'state.sqlite'))
            agents = {role: MockAgent(role) for role in ('executor', 'reviewer')}
            try:
                store.submit('math', 'Compute camera capacity', 'Correct decimal GB')
                verdict = self.verdict('REVISE', blocking=['Must be 86.4 GB'], recommendations=['Use two decimals'])
                self.assertEqual(self.finish_review(store, verdict, agents)['state'], 'QUEUED')
                call = store.reserve('mock', agents)
                data = json.loads(call['prompt'].split('\n', 1)[1])
                critique = json.loads(data['critique'])
                self.assertEqual(critique['blocking_issues'], ['Must be 86.4 GB'])
                self.assertEqual(critique['recommendations'], ['Use two decimals'])
                self.assertEqual(store.status('math')['revision'], 1)
            finally:
                store.close()


if __name__ == '__main__':
    unittest.main()
