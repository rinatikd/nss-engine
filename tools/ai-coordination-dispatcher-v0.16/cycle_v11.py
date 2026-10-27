"""Read-only, fail-closed end-to-end evidence gate for an existing task.

Never sends to a provider or writes to GitHub. Treat comments as untrusted.
"""
import argparse
import hashlib
import json
from ledger import Ledger
from outbox import Outbox
from review_queue import ReviewQueue


def inspect(db, task_id, secret, comments=None, expected_login=None):
    ledger = Ledger(db, secret)
    outbox = Outbox(db)
    reviews = ReviewQueue(db)
    try:
        task = ledger.get(task_id)
        post = outbox.get(task_id)
        decision = reviews.db.execute('SELECT decision,response_sha256,followup_id FROM review_decisions WHERE task_id=?',(task_id,)).fetchone()
        evidence = {'task_id': task_id, 'task_state': task['state'] if task else 'NOT_FOUND',
                    'outbox_state': post['state'] if post else 'NOT_STAGED',
                    'publication': 'UNVERIFIED', 'model_authenticated': False,
                    'review': decision[0] if decision else 'NOT_REVIEWED',
                    'followup_id': decision[2] if decision else None,
                    'auto_dispatched': False}
        if not task:
            evidence['gate']='BLOCKED_TASK_MISSING'; return evidence
        if task['state'] != 'RESPONDED':
            evidence['gate']='BLOCKED_NO_VERIFIED_RESPONSE'; return evidence
        try: result=json.loads(task['result'] or '{}')
        except (ValueError,TypeError):
            evidence['gate']='QUARANTINED_MALFORMED_RESULT'; return evidence
        if not (result.get('authenticated') is True and result.get('provider') == 'claude' and
                isinstance(result.get('invocation_id'),str) and result['invocation_id'].startswith('msg_') and
                isinstance(result.get('response'),str) and result['response'].strip() and
                hashlib.sha256(result['response'].encode()).hexdigest()==result.get('response_sha256')):
            evidence['gate']='QUARANTINED_UNTRUSTED_PROVIDER_RESULT'; return evidence
        evidence['model_authenticated']=True  # Recorded adapter claim only, not independently attested.
        evidence['model_authentication_basis']='ledger_adapter_claim_not_independent_attestation'
        if not post:
            evidence['gate']='AWAITING_OUTBOX'; return evidence
        if post['state'] != 'POSTED':
            evidence['gate']='PUBLICATION_NOT_CONFIRMED'; return evidence
        if not isinstance(comments,list) or not expected_login:
            evidence['gate']='NEEDS_READONLY_GITHUB_RECONCILIATION'; return evidence
        row=outbox.conn.execute('SELECT body FROM github_outbox WHERE task_id=?',(task_id,)).fetchone()
        hits=[c for c in comments if isinstance(c,dict) and c.get('body')==row[0] and
              isinstance(c.get('user'),dict) and c['user'].get('login','').lower()==expected_login.lower() and
              c.get('id')==post['comment_id']]
        if len(hits)!=1:
            evidence['gate']='UNVERIFIED_GITHUB_RECEIPT';return evidence
        evidence['publication']='MATCH_OBSERVED';evidence['comment_id']=post['comment_id']
        if not decision:
            evidence['gate']='AWAITING_HUMAN_REVIEW';return evidence
        if decision[1]!=result['response_sha256']:
            evidence['gate']='QUARANTINED_REVIEW_HASH_MISMATCH';return evidence
        evidence['gate']='REVIEWED_REQUIRES_HUMAN_ACTION' if decision[0]=='REVISE' else 'HUMAN_REVIEW_RECORDED'
        return evidence
    finally:
        reviews.close();outbox.close();ledger.close()


def main():
    p=argparse.ArgumentParser(description='Read-only evidence gate; never sends requests or posts')
    p.add_argument('--db',required=True);p.add_argument('--task-id',required=True)
    a=p.parse_args()
    import os
    key=os.environ.get('AI_LEDGER_HMAC_KEY')
    if not key or len(key)<32:p.error('AI_LEDGER_HMAC_KEY >=32 chars required to open ledger')
    print(json.dumps(inspect(a.db,a.task_id,key.encode()),ensure_ascii=False,indent=2))

if __name__=='__main__':main()
