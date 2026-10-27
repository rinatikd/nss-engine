"""v0.12 offline evidence package. No provider calls or GitHub writes.

Report is a *snapshot of ledger claims*, not independent provider attestation.
The GitHub comment list must be provided by an authenticated, trusted fetcher;
this module cannot verify the collection method.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
from cycle_v11 import inspect

SCHEMA = 'ai-coordination-pilot-evidence/v1'

def load_comments(path):
    if path is None:
        return None
    raw = Path(path).read_bytes()
    if len(raw) > 5_000_000:
        raise ValueError('comments file too large')
    data = json.loads(raw.decode('utf-8-sig'))
    if not isinstance(data, list) or len(data) > 10000:
        raise ValueError('comments must be a bounded JSON array')
    for item in data:
        if not isinstance(item, dict) or not isinstance(item.get('body'), str):
            raise ValueError('invalid comment record')
        if len(item['body']) > 100000:
            raise ValueError('comment body too long')
    return data

def snapshot(db, task_id, key, comments=None, expected_login=None):
    if not isinstance(key, bytes) or len(key) < 32:
        raise ValueError('HMAC key must be >=32 bytes')
    if comments is not None and not isinstance(comments,list):
        raise ValueError('comments must be a list')
    result=inspect(db, task_id, key, comments, expected_login)
    report={
        'schema': SCHEMA,
        'task_id': task_id,
        'evidence_gate': result['gate'],
        'observations': result,
        'github_comments_provenance':'USER_SUPPLIED_NOT_INDEPENDENTLY_ATTESTED' if comments is not None else 'NOT_SUPPLIED',
        'provider_provenance':'LEDGER_ADAPTER_CLAIM_NOT_INDEPENDENTLY_ATTESTED',
        'outbound_actions':0,
        'human_approval_required':True,
    }
    body=json.dumps(report,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode('utf-8')
    report['evidence_sha256']=hashlib.sha256(body).hexdigest()
    # Integrity within the same trusted host, NOT proof of model authenticity.
    report['evidence_hmac_sha256']=hmac.new(key,body,hashlib.sha256).hexdigest()
    return report

def verify(report,key):
    if not isinstance(report,dict) or report.get('schema')!=SCHEMA:
        return False
    if not isinstance(key,bytes) or len(key)<32:return False
    d=dict(report)
    signed=d.pop('evidence_hmac_sha256',None)
    digest=d.pop('evidence_sha256',None)
    body=json.dumps(d,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode('utf-8')
    if not isinstance(signed,str) or not isinstance(digest,str):return False
    return hmac.compare_digest(digest,hashlib.sha256(body).hexdigest()) and hmac.compare_digest(signed,hmac.new(key,body,hashlib.sha256).hexdigest())

def main():
    parser=argparse.ArgumentParser(description='Offline read-only pilot evidence; does not invoke Claude or write GitHub')
    parser.add_argument('--db',required=True);parser.add_argument('--task-id',required=True)
    parser.add_argument('--comments-json');parser.add_argument('--expected-login');parser.add_argument('--output')
    args=parser.parse_args()
    raw=os.environ.get('AI_LEDGER_HMAC_KEY','').encode()
    if len(raw)<32:parser.error('AI_LEDGER_HMAC_KEY must contain >=32 characters')
    if args.comments_json and not args.expected_login:parser.error('--expected-login required with --comments-json')
    doc=snapshot(args.db,args.task_id,raw,load_comments(args.comments_json),args.expected_login)
    rendered=json.dumps(doc,ensure_ascii=False,indent=2)+'\n'
    if args.output:
        target=Path(args.output)
        if target.exists():parser.error('refusing to overwrite evidence artifact')
        with target.open('x',encoding='utf-8') as f:f.write(rendered)
    else:print(rendered,end='')

if __name__=='__main__':main()
