"""Read-only GitHub outbox reconciliation. A missing result never authorizes re-send.
Uses existing receipt module with transport injection for tests.
"""
import argparse, json, os
from outbox import Outbox
from receipt import github_comments


def reconcile(db,task_id,repo,issue,token,fetcher=None):
    if not repo or not token or not str(issue).isdigit():
        return {'status':'BLOCKED','reason':'read_only_credentials_missing'}
    out=Outbox(db)
    try:
        state=out.get(task_id)
        if not state: return {'status':'BLOCKED','reason':'unknown_task'}
        if state['state'] not in ('UNKNOWN','POSTED'):
            return {'status':'NOT_ELIGIBLE','outbox_state':state['state'],'no_repost':True}
        if state['state']=='POSTED':
            return {'status':'ALREADY_RECORDED','comment_id':state['comment_id'],'no_repost':True}
        # Read-only call only; all exceptions fail closed.
        try:
            comments=(fetcher or github_comments)(repo,int(issue),token)
        except Exception:
            return {'status':'CHECK_FAILED','no_repost':True}
        # This does not blindly confirm copied marker text; an exact payload match is needed.
        row=out.conn.execute('SELECT body FROM github_outbox WHERE task_id=?',(task_id,)).fetchone()
        matches=[c.get('id') for c in comments if isinstance(c,dict) and c.get('body')==row[0] and isinstance(c.get('id'),int)]
        if len(matches)!=1:
            return {'status':'UNRESOLVED','matches':len(matches),'no_repost':True}
        # Deliberately not updating DB automatically: GitHub identity cannot attest model authorship.
        return {'status':'MATCH_OBSERVED_UNVERIFIED','comment_id':matches[0], 'no_repost':True}
    finally:out.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--db',required=True);p.add_argument('--task-id',required=True)
    a=p.parse_args()
    print(json.dumps(reconcile(a.db,a.task_id,os.getenv('GITHUB_REPOSITORY'),os.getenv('GITHUB_ISSUE_NUMBER','40'),os.getenv('GITHUB_TOKEN')),ensure_ascii=False,indent=2))
