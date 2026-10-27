"""Non-executing review of posted evidence and bounded follow-up draft generation."""
import hashlib, json, re

ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')

def review_and_draft(task_id, reply, evidence, revision=0, max_revisions=2):
    if not ID.fullmatch(task_id): raise ValueError('invalid task id')
    if not isinstance(reply,str) or len(reply)>20000: raise ValueError('invalid reply')
    if not isinstance(evidence,dict): raise ValueError('invalid evidence')
    checks={
       'has_invocation_id':bool(evidence.get('invocation_id')),
       'authenticated_provider':evidence.get('authenticated') is True,
       'sha256_matches':hashlib.sha256(reply.encode()).hexdigest()==evidence.get('sha256'),
       'nonempty_response':bool(reply.strip())
    }
    passed=all(checks.values())
    decision='REVIEW_REQUIRED' if passed else 'QUARANTINED'
    followup=None
    if passed and evidence.get('review_status')=='NEEDS_REVISION' and revision<max_revisions:
       followup={'task_id':f'{task_id}.r{revision+1}', 'revision':revision+1,
       'prompt':'Review the previous response and correct the identified issues. Original response SHA256: '+checks_hash(reply)+'. Critique: '+str(evidence.get('critique',''))[:1500],
       'state':'DRAFT_REQUIRES_APPROVAL'}
    return {'decision':decision,'checks':checks,'followup':followup,'auto_dispatched':False}

def checks_hash(s):return hashlib.sha256(s.encode()).hexdigest()
