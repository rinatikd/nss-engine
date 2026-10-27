"""Read-only operator console for the v0.13 pilot. No provider calls or posts."""
import argparse
import json
import os
import sqlite3
import urllib.error
from pathlib import Path
from pilot_v13 import preflight
from outbox import Outbox
from receipt import github_comments


def doctor(env=None):
    e = os.environ if env is None else env
    p = preflight(e,live=True)
    # This reports capability intent, not a verified credential nor billing balance.
    return {'status':'READY_FOR_OPERATOR_REVIEW' if p['ready'] else 'BLOCKED_PRECHECK',
            'checks':p['checks'], 'real_api_invocation_verified':False,
            'github_write_verified':False, 'calls_sent':0,
            'next':'Only run --live-claude after separate operator approval and sandbox assessment.'}


def inspect(db,task_id):
    if not Path(db).is_file():
        return {'status':'NO_DATABASE','task_id':task_id,'no_retry':True}
    o=Outbox(db)
    try:
        row=o.get(task_id)
        if row is None:
            return {'status':'NO_OUTBOX_RECORD','task_id':task_id,'no_retry':True}
        return {'status':'OBSERVED','task_id':task_id,'outbox':row,'no_retry':True,
                'note':'POSTED is a local receipt record, not proof of provider identity.'}
    finally:o.close()


def verify_github(db,task_id,repo,issue,token,expected_login,fetcher=None):
    # Never changes database state. Never automatically retries a POST.
    if not expected_login or not token:
        return {'status':'BLOCKED_READ_CREDENTIALS','no_retry':True}
    if not Path(db).is_file():
        return {'status':'NO_DATABASE','no_retry':True}
    o=Outbox(db)
    try:
        rec=o.conn.execute('SELECT state,body,comment_id FROM github_outbox WHERE task_id=?',(task_id,)).fetchone()
        if rec is None:
            return {'status':'NO_OUTBOX_RECORD','no_retry':True}
        state,body,cid=rec
        try:
            comments=(fetcher or github_comments)(repo,issue,token)
        except Exception:
            return {'status':'READ_FAILED','no_retry':True}
        matches=[x for x in comments if isinstance(x,dict) and x.get('body')==body
                 and isinstance(x.get('id'),int) and x.get('id')>0
                 and isinstance(x.get('user'),dict)
                 and x['user'].get('login','').casefold()==expected_login.casefold()]
        if len(matches)!=1:
            return {'status':'AMBIGUOUS' if matches else 'NOT_OBSERVED',
                    'match_count':len(matches),'outbox_state':state,'no_retry':True}
        observed=matches[0]['id']
        return {'status':'GITHUB_COMMENT_OBSERVED', 'comment_id':observed,
                'outbox_id_matches':cid==observed if cid is not None else None,
                'outbox_state':state,'no_retry':True,
                'provider_identity_verified':False,
                'note':'Read-only observation of a GitHub comment; provider authenticity not proven.'}
    finally:o.close()


def main():
    p=argparse.ArgumentParser(description='Read-only v0.14 operations console; never posts or calls providers')
    sub=p.add_subparsers(dest='cmd',required=True)
    sub.add_parser('doctor')
    a=sub.add_parser('inspect');a.add_argument('--db',required=True);a.add_argument('--task-id',required=True)
    b=sub.add_parser('verify-github');b.add_argument('--db',required=True);b.add_argument('--task-id',required=True)
    b.add_argument('--expected-login',required=True);b.add_argument('--repo',default=os.getenv('GITHUB_REPOSITORY',''))
    b.add_argument('--issue',type=int,default=int(os.getenv('GITHUB_ISSUE_NUMBER','40')))
    b.add_argument('--live-read',action='store_true')
    args=p.parse_args()
    if args.cmd=='doctor':r=doctor()
    elif args.cmd=='inspect':r=inspect(args.db,args.task_id)
    elif not args.live_read:r={'status':'BLOCKED_READ_OPT_IN','no_retry':True}
    else:r=verify_github(args.db,args.task_id,args.repo,args.issue,os.getenv('GITHUB_TOKEN'),args.expected_login)
    print(json.dumps(r,ensure_ascii=False,indent=2))

if __name__=='__main__': main()
