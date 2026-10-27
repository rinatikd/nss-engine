"""Source-only opt-in model dispatcher. No execution without explicit --live flag."""
import argparse, hashlib, json, os, sys, time, urllib.request, urllib.error, uuid
from ledger import Ledger
from budget import Budget
from paid_policy import require_paid_api_allowed

class PreDispatchError(RuntimeError): pass
class UnknownDelivery(RuntimeError): pass

def https_post(url, obj, headers, timeout=75):
    b=json.dumps(obj).encode('utf-8')
    req=urllib.request.Request(url, data=b, headers={**headers,'Content-Type':'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read(2_000_000)), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        # Non-2xx responses are ambiguous unless separately proven not accepted.
        raise UnknownDelivery('provider HTTP status '+str(exc.code)) from None
    except (urllib.error.URLError,TimeoutError,OSError,ValueError) as exc:
        raise UnknownDelivery('provider transport failure') from None

def invoke(provider, prompt, live=False):
    if not live:
        return {'provider':'mock','invocation_id':'mock-'+uuid.uuid4().hex,'text':'ACK: mock adapter received the request. RESPONSE: '+prompt[:120], 'authenticated':False}
    require_paid_api_allowed()
    if provider != 'claude': raise PreDispatchError('Only Claude API adapter is implemented')
    key=os.getenv('ANTHROPIC_API_KEY')
    if not key: raise PreDispatchError('ANTHROPIC_API_KEY missing; no request sent')
    model=os.getenv('ANTHROPIC_MODEL','claude-sonnet-4-5')
    url='https://api.anthropic.com/v1/messages'
    data,headers=https_post(url,{'model':model,'max_tokens':512,'messages':[{'role':'user','content':prompt}]},
      {'x-api-key':key,'anthropic-version':'2023-06-01'})
    content=data.get('content',[])
    if not isinstance(content,list) or not data.get('id'): raise UnknownDelivery('provider response missing id/content')
    return {'provider':'claude','invocation_id':data['id'], 'request_id':headers.get('request-id'),
            'text':'\n'.join(x.get('text','') for x in content if x.get('type')=='text'),
            'authenticated':True,'model':data.get('model'),'usage':data.get('usage')}

def run(db, secret, task_id, prompt, live=False, publish=False):
    if publish: raise ValueError('Direct publish is disabled in v0.4; use durable outbox.py after staging')
    if live:
        try:
            require_paid_api_allowed()
        except PermissionError:
            return {'task_id':task_id,'state':'BLOCKED','reason':'paid_api_disabled_by_policy','sent':False}
    owner='dispatcher:'+str(os.getpid())
    store=Ledger(db,secret)
    try:
        payload={'prompt':prompt,'provider':'claude' if live else 'mock'}
        claim=store.claim(task_id,payload,owner,ttl=180)
        if claim['status']!='created': return {'task_id':task_id,'claim':claim,'sent':False}
        token=claim['token']
        # Validate pre-send requirements before crossing the uncertain send boundary.
        if live and not os.getenv('ANTHROPIC_API_KEY'):
            store.transition(task_id,token,'CLAIMED','CANCELLED',result={'reason':'credentials_missing'})
            return {'task_id':task_id,'state':'CANCELLED','sent':False}
        if live:
            # Explicit opt-in quotas. Reserved calls count on UNKNOWN and failures.
            max_calls=int(os.getenv('AI_MAX_CALLS_PER_DAY','0'))
            max_tokens=int(os.getenv('AI_MAX_PLANNED_TOKENS_PER_DAY','0'))
            planned=(len(prompt)+3)//4+512 # heuristic, NOT a billing guarantee
            budget=Budget(db)
            try: allowed=budget.reserve(max_calls,max_tokens,planned)
            finally:budget.close()
            if not allowed:
                store.transition(task_id,token,'CLAIMED','CANCELLED',result={'reason':'budget_cap'})
                return {'task_id':task_id,'state':'CANCELLED','reason':'budget_cap','sent':False}
        store.transition(task_id,token,'CLAIMED','DISPATCHING')
        try:
            reply=invoke('claude',prompt,live)
        except PreDispatchError:
            # Credentials and provider selection are checked before dispatch; unexpected errors are UNKNOWN.
            store.transition(task_id,token,'DISPATCHING','UNKNOWN',result={'reason':'preflight_error_after_dispatch_mark'})
            return {'task_id':task_id,'state':'UNKNOWN','sent':'unverified'}
        except UnknownDelivery as exc:
            store.transition(task_id,token,'DISPATCHING','UNKNOWN',result={'reason':str(exc)})
            return {'task_id':task_id,'state':'UNKNOWN','sent':'unverified'}
        except BaseException:
            store.transition(task_id,token,'DISPATCHING','UNKNOWN',result={'reason':'unexpected_exception'})
            raise
        result={'task_id':task_id,'state':'RESPONDED','invocation_id':reply['invocation_id'],
                'provider':reply['provider'],'authenticated':reply['authenticated'],
                'response_sha256':hashlib.sha256(reply['text'].encode()).hexdigest(),
                'response':reply['text'],'provider_request_id':reply.get('request_id')}
        if not store.transition(task_id,token,'DISPATCHING','RESPONDED',result):
            return {'task_id':task_id,'state':'UNKNOWN','error':'ledger_transition_failed'}
        if publish:
            gh_repo=os.getenv('GITHUB_REPOSITORY')
            gh_token=os.getenv('GITHUB_TOKEN')
            issue=os.getenv('GITHUB_ISSUE_NUMBER','40')
            if not gh_repo or not gh_token or not issue.isdecimal():
                result['github']='BLOCKED: missing repo/token/issue';return result
            body=(f'[DISPATCHER RELAY {task_id}]\nProvider: {reply["provider"]}\n'
                  f'Invocation id: {reply["invocation_id"]}\nAuthenticated provider response: {reply["authenticated"]}\n'
                  f'Response SHA256: {result["response_sha256"]}\n'
                  f'RESPONSE (untrusted model text):\n```text\n{reply["text"][:3000].replace("```","` ` `")}\n```')
            try:
                https_post('https://api.github.com/repos/'+gh_repo+'/issues/'+issue+'/comments',{'body':body},
                           {'Authorization':'Bearer '+gh_token,'Accept':'application/vnd.github+json','User-Agent':'ai-coordination-dispatcher-v0.2'},timeout=20)
                result['github']='POSTED'
            except UnknownDelivery:
                result['github']='UNKNOWN: do not automatically repost'
        return result
    finally:store.close()

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--db',required=True);p.add_argument('--task-id',required=True);p.add_argument('--prompt',required=True)
    p.add_argument('--live',action='store_true');p.add_argument('--publish',action='store_true')
    a=p.parse_args()
    sec=os.getenv('AI_LEDGER_HMAC_KEY','')
    if not sec:
        if a.live: p.error('AI_LEDGER_HMAC_KEY must be set for live mode')
        sec='local-mock-only-secret-not-for-production-'*2
    print(json.dumps(run(a.db,sec.encode(),a.task_id,a.prompt,a.live,a.publish),ensure_ascii=False,indent=2))
if __name__=='__main__':main()
