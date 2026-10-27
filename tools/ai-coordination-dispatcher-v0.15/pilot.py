"""Explicit single-task pilot: provider -> ledger -> durable GitHub outbox.
No publishing in this command. Live provider calls require dispatcher guards.
"""
import argparse, hashlib, json, os
from pathlib import Path
from dispatcher import run
from outbox import Outbox, render_response
from review_loop import review_and_draft


def pilot(db, task_id, prompt, live=False, max_revisions=2):
    if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>16000:
        raise ValueError('prompt must contain 1..16000 chars')
    key=os.environ.get('AI_LEDGER_HMAC_KEY','')
    if live and (len(key)<32 or not os.environ.get('ANTHROPIC_API_KEY')):
        return {'status':'BLOCKED','reason':'missing_live_secrets','api_invoked':False}
    secret=key.encode() if key else b'local-mock-only-secret-not-for-production-'*2
    result=run(db,secret,task_id,prompt,live=live,publish=False)
    if result.get('state')!='RESPONDED':
        return {'status':result.get('state',result.get('claim',{}).get('status','BLOCKED')),'provider':result.get('provider'),'published':False,'detail':result}
    response=result['response']
    checks=review_and_draft(task_id,response,{'invocation_id':result['invocation_id'], 'authenticated':result['authenticated'], 'sha256':hashlib.sha256(response.encode()).hexdigest()},max_revisions=max_revisions)
    if not live:
        return {'status':'DRY_RUN','review':checks,'api_invoked':False,'published':False,'outbox_enqueued':False,'provider_invocation':result['invocation_id']}
    if checks['decision']!='REVIEW_REQUIRED':
        return {'status':'QUARANTINED','review':checks,'published':False}
    body=render_response(task_id,result['invocation_id'],'claude',response,True)
    out=Outbox(db)
    try: stage=out.enqueue(task_id,body)
    finally:out.close()
    return {'status':'STAGED','provider_invocation':result['invocation_id'],'review':checks,'outbox':stage,'published':False,'next':'explicit outbox publish with authorized GitHub token'}


def main():
    p=argparse.ArgumentParser(description='Safe one-task pilot, never publishes to GitHub')
    p.add_argument('--db',required=True);p.add_argument('--task-id',required=True)
    g=p.add_mutually_exclusive_group(required=True);g.add_argument('--prompt');g.add_argument('--prompt-file')
    p.add_argument('--live-claude',action='store_true')
    a=p.parse_args()
    prompt=Path(a.prompt_file).read_text(encoding='utf-8') if a.prompt_file else a.prompt
    print(json.dumps(pilot(a.db,a.task_id,prompt,live=a.live_claude),ensure_ascii=False,indent=2))
if __name__=='__main__': main()
