"""Background analysis worker. Writes a terminal status; never changes a DWG."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import traceback
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from nss_engine.contract_v042 import validate_snapshot
from nss_engine.pipeline_v042 import analyze_entities


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--input',type=Path,required=True)
    p.add_argument('--output-dir',type=Path,required=True)
    p.add_argument('--drawing-id');p.add_argument('--drawing-name')
    args=p.parse_args()
    out=args.output_dir.resolve()
    if out==args.input.resolve() or out in args.input.resolve().parents:raise ValueError('output must be separate')
    if out.exists() and any(out.iterdir()):raise ValueError('output directory must be new or empty')
    out.mkdir(parents=True,exist_ok=True)
    def write(name,data):
        tmp=out/(name+'.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf8');tmp.replace(out/name)
    try:
        write('status.json',dict(phase='RUNNING',input=str(args.input)))
        if args.input.stat().st_size>256_000_000:raise ValueError('snapshot exceeds 256 MB')
        raw=args.input.read_bytes();before=hashlib.sha256(raw).hexdigest()
        data=json.loads(raw.decode('utf-8-sig'));validate_snapshot(data)
        if args.drawing_id and data['drawing']['id']!=args.drawing_id:raise ValueError('drawing fingerprint mismatch')
        if args.drawing_name and data['drawing']['name'].casefold()!=args.drawing_name.casefold():raise ValueError('drawing name mismatch')
        report=analyze_entities(data['entities']);report['drawing']=data['drawing'];report['source_coverage']=data['coverage']
        if hashlib.sha256(args.input.read_bytes()).hexdigest()!=before:raise ValueError('source changed during analysis')
        write('analysis_v042.json',report)
        write('status.json',dict(phase='COMPLETED_REVIEW_REQUIRED',snapshot_sha256=before,report='analysis_v042.json',autocad_runtime_verified=False))
        return 0
    except Exception as error:
        (out/'error.log').write_text(traceback.format_exc(),encoding='utf8')
        write('status.json',dict(phase='FAILED',exception=type(error).__name__,message=str(error)))
        return 2


if __name__=='__main__':raise SystemExit(main())
