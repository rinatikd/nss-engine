"""Stage verified dispatcher results into outbox; never publishes implicitly."""
import argparse,json
from outbox import Outbox,render_response

def stage(db, records):
 out=Outbox(db);results=[]
 try:
  for r in records:
   if not isinstance(r,dict) or r.get('state')!='RESPONDED' or not r.get('authenticated'):
    results.append({'status':'IGNORED'});continue
   body=render_response(r['task_id'],r['invocation_id'],r['provider'],r['response'],r['authenticated'])
   results.append({'task_id':r['task_id'],**out.enqueue(r['task_id'],body)})
  return results
 finally:out.close()
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--db',required=True);p.add_argument('--results-file',required=True);args=p.parse_args()
 print(json.dumps(stage(args.db,json.load(open(args.results_file,encoding='utf8'))),ensure_ascii=False,indent=2))
