"""Fail-closed preflight for a deliberately operator-started, paid Claude/GitHub pilot.
This module never sends requests and never prints credentials.
"""
import argparse, json, os, re

REPO = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')

def inspect(env=None):
    e=os.environ if env is None else env
    errors=[]; warnings=[]
    def required(name, predicate, message):
        if not predicate(e.get(name,'')): errors.append(message)
    required('ANTHROPIC_API_KEY',lambda x:len(x)>=16,'Claude API key missing or obviously invalid')
    required('AI_LEDGER_HMAC_KEY',lambda x:len(x)>=32,'ledger HMAC secret must have at least 32 characters')
    required('GITHUB_TOKEN',lambda x:len(x)>=16,'GitHub API token missing or obviously invalid')
    required('GITHUB_REPOSITORY',lambda x:bool(REPO.fullmatch(x)),'GitHub repository must have owner/name form')
    required('GITHUB_ISSUE_NUMBER',lambda x:x.isdecimal() and int(x)>0,'GitHub issue number must be positive')
    for n in ('AI_MAX_CALLS_PER_DAY','AI_MAX_PLANNED_TOKENS_PER_DAY'):
        try:
            if int(e.get(n,'0'))<=0:errors.append(n+' must be explicitly set to a positive integer')
        except ValueError:errors.append(n+' must be numeric')
    if e.get('AI_APPROVE_REAL_REQUEST') != 'YES_I_APPROVE_ONE_PAID_CLAUDE_REQUEST':
        errors.append('operator opt-in for paid model call not set')
    if e.get('AI_APPROVE_GITHUB_WRITE') != 'YES_I_APPROVE_GITHUB_ISSUE_WRITE':
        errors.append('operator opt-in for GitHub comment write not set')
    return {'ready':not errors,'errors':errors,'warnings':warnings,
            'actions_performed':[],'credentials_printed':False,
            'warning':'Readiness checks only: no verification of key validity, account balance, permissions or network connectivity'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');p.parse_args()
    print(json.dumps(inspect(),ensure_ascii=False,indent=2))
