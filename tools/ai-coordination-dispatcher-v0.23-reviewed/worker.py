"""One-shot, opt-in queue worker. Never invokes live provider unless --live supplied."""
import argparse, json, os, pathlib, re, sys
from dispatcher import run

ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')

def process(queue, db, live=False, publish=False, max_tasks=5, max_prompt_chars=8000):
    if publish and not live:
        raise ValueError('Publishing mock output is prohibited')
    if max_tasks < 1 or max_tasks > 100: raise ValueError('invalid batch limit')
    root=pathlib.Path(queue).resolve()
    if not root.is_dir(): raise ValueError('queue directory missing')
    secret=os.environ.get('AI_LEDGER_HMAC_KEY')
    if live and (not secret or len(secret)<32): raise ValueError('missing AI_LEDGER_HMAC_KEY')
    results=[]
    for path in sorted(root.glob('*.json'))[:max_tasks]:
        if path.is_symlink() or not path.is_file() or path.stat().st_size>max_prompt_chars*4:
            results.append({'file':path.name,'state':'REJECTED','reason':'unsafe file'});continue
        try:
            task=json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(task,dict) or set(task)!={'task_id','prompt'}: raise ValueError('unsupported task format')
            task_id,prompt=task['task_id'],task['prompt']
            if not isinstance(task_id,str) or not ID.fullmatch(task_id):raise ValueError('invalid task_id')
            if not isinstance(prompt,str) or not 1<=len(prompt)<=max_prompt_chars:raise ValueError('invalid prompt length')
            # Preflight before any provider invocation; ledger deduplicates repeated runs.
            results.append(run(db,(secret or 'local-mock-only-secret-not-for-production-'*2).encode(),task_id,prompt,live,publish))
        except (ValueError,KeyError,UnicodeError,json.JSONDecodeError) as e:
            results.append({'file':path.name,'state':'REJECTED','reason':type(e).__name__})
    return results

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--queue',required=True);ap.add_argument('--db',required=True)
    ap.add_argument('--live',action='store_true');ap.add_argument('--publish',action='store_true')
    ap.add_argument('--max-tasks',type=int,default=5);ap.add_argument('--max-prompt-chars',type=int,default=8000)
    opts=ap.parse_args()
    print(json.dumps(process(opts.queue,opts.db,opts.live,opts.publish,opts.max_tasks,opts.max_prompt_chars),ensure_ascii=False,indent=2))
if __name__=='__main__':main()
