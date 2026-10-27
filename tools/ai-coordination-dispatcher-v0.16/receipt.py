"""Read-only GitHub reconciliation: NEVER turns absence into permission to resend."""
import argparse, json, os, urllib.request
from outbox import Outbox, REPO


def github_comments(repo, issue, token, max_pages=10):
    if not REPO.fullmatch(repo or '') or not str(issue).isdigit() or int(issue)<1:
        raise ValueError('invalid GitHub target')
    if not token: raise ValueError('missing token')
    items=[]
    for page in range(1,max_pages+1):
        url=f'https://api.github.com/repos/{repo}/issues/{int(issue)}/comments?per_page=100&page={page}'
        req=urllib.request.Request(url,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'ai-dispatcher-v05'})
        with urllib.request.urlopen(req,timeout=15) as resp: batch=json.loads(resp.read(3000000))
        if not isinstance(batch,list): raise ValueError('unexpected GitHub payload')
        items.extend(batch)
        if len(batch)<100:return items
    raise RuntimeError('pagination incomplete: cannot assert absence')


def reconcile(db, task_id, comments, expected_login=None):
    o=Outbox(db)
    try:
        row=o.conn.execute('SELECT state,body,payload_hash,comment_id FROM github_outbox WHERE task_id=?',(task_id,)).fetchone()
        if not row: raise ValueError('unknown task')
        state,body,hash_,comment_id=row
        matches=[]
        for c in comments:
            if not isinstance(c,dict) or c.get('body')!=body:continue
            if expected_login and c.get('user',{}).get('login','').lower()!=expected_login.lower():continue
            if isinstance(c.get('id'),int) and c['id']>0:matches.append(c['id'])
        if len(matches)!=1:return {'state':state,'matches':len(matches),'status':'AMBIGUOUS' if matches else 'NOT_FOUND_NO_RETRY'}
        cid=matches[0]
        if state=='POSTED' and comment_id==cid:return {'state':state,'status':'ALREADY_VERIFIED','comment_id':cid}
        if state not in ('UNKNOWN','POSTED'):return {'state':state,'status':'OBSERVED_NO_TRANSITION','comment_id':cid}
        o.conn.execute('BEGIN IMMEDIATE')
        try:
            now=o.conn.execute('SELECT state,comment_id FROM github_outbox WHERE task_id=?',(task_id,)).fetchone()
            if now[0]!=state or (state=='POSTED' and now[1]!=cid):
                result={'status':'STATE_CHANGED','state':now[0]}
            else:
                o.conn.execute('UPDATE github_outbox SET state=?,comment_id=?,note=? WHERE task_id=?',('POSTED',cid,'reconciled_exact_body_and_author',task_id))
                result={'state':'POSTED','status':'RECONCILED','comment_id':cid}
            o.conn.execute('COMMIT');return result
        except BaseException:o.conn.execute('ROLLBACK');raise
    finally:o.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--db',required=True);p.add_argument('--task-id',required=True)
    p.add_argument('--repo',default=os.getenv('GITHUB_REPOSITORY'));p.add_argument('--issue',default=os.getenv('GITHUB_ISSUE_NUMBER','40'))
    p.add_argument('--expected-login',required=True);p.add_argument('--live-read',action='store_true')
    a=p.parse_args()
    if not a.live_read: p.error('explicit --live-read required')
    print(json.dumps(reconcile(a.db,a.task_id,github_comments(a.repo,a.issue,os.getenv('GITHUB_TOKEN')),a.expected_login)))
