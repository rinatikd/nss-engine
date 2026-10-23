"""Bounded AST update, preserving the rest of the large existing project graph."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import argparse
import subprocess
import sys
from datetime import datetime, timezone

os.environ['GRAPHIFY_MAX_GRAPH_BYTES'] = '2GB'
os.environ['GRAPHIFY_MAX_WORKERS'] = '1'
from graphify.extract import extract
from graphify.watch import _rebuild_lock


def normalize(path):
    return (path or '').replace('\\', '/').casefold()


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--release-tag',default='v022')
    parser.add_argument('--attempt-cli',action='store_true')
    args=parser.parse_args()
    if not args.release_tag.isalnum():
        raise ValueError('A simple release tag is required')
    workspace=Path.cwd().resolve()
    graph=Path('graphify-out/graph.json')
    backup=graph.parent/'backups'/f'graph_pre_tkk_{args.release_tag}.json'
    if not backup.exists():
        backup.parent.mkdir(exist_ok=True)
        shutil.copy2(graph,backup)
    cli_status='not requested; previous full-context resolver stalls are recorded in AUTONOMOUS_PROGRESS_RU.md'
    if args.attempt_cli:
        log=graph.parent/f'tkk_{args.release_tag}_cli_update.log'
        print('Running graphify update . --no-cluster with a 45-second owned-process limit',flush=True)
        with log.open('w',encoding='utf8') as stream:
            child=subprocess.Popen([sys.executable,'-m','graphify','update','.','--no-cluster'],stdout=stream,stderr=subprocess.STDOUT,env=os.environ.copy())
            try:
                code=child.wait(timeout=45)
                cli_status=f'graphify update . --no-cluster exited {code}'
            except subprocess.TimeoutExpired:
                # Only the process launched above and its descendants are owned.
                # Never enumerate or stop unrelated Python/user processes.
                if child.poll() is None:
                    killed=subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],stdout=stream,stderr=subprocess.STDOUT)
                    if killed.returncode:
                        raise RuntimeError('Could not stop the owned graph update process')
                    child.wait(timeout=10)
                cli_status='graphify update . --no-cluster exceeded 45 seconds; owned process tree stopped; bounded AST merge used'
        print(cli_status,flush=True)
    changes=[Path(__file__).resolve()]
    roots=[Path('work/NSS_TKK_Editor_v0.2'), *Path('output').glob('NSS_TKK_Editor_v0.2*')]
    for root in roots:
        if not root.is_dir():
            continue
        for folder in ('source', 'engine', 'tests', 'scripts', 'native'):
            for path in (root/folder).rglob('*'):
                if path.suffix in ('.py', '.cs', '.csproj') and not {'bin', 'obj', '__pycache__'} & set(path.parts):
                    changes.append(path.resolve())
    print(f'AST extraction: {len(changes)} product files, bounded resolver context; no LLM calls', flush=True)
    fresh=extract(changes, root=workspace, cache_root=workspace, parallel=False)
    print(f'Fresh extraction: {len(fresh["nodes"])} nodes, {len(fresh["edges"])} edges', flush=True)
    changed={normalize(path.relative_to(workspace).as_posix()) for path in changes}
    with _rebuild_lock(graph.parent, blocking=True) as locked:
        if not locked:
            raise SystemExit('Graph is locked')
        before=graph.stat()
        data=json.loads(graph.read_text(encoding='utf8'))
        old_count=len(data['nodes'])
        # Only replace AST owned by the explicitly updated sources. Other graph
        # nodes/edges and semantic evidence are preserved without re-resolution.
        nodes={n['id']:n for n in data['nodes'] if not (normalize(n.get('source_file')) in changed and n.get('_origin')=='ast')}
        for node in fresh['nodes']:
            if node['id'] not in nodes or normalize(node.get('source_file')) in changed:
                nodes[node['id']]=node
        edge_key='links' if 'links' in data else 'edges'
        edges=[e for e in data[edge_key] if not (normalize(e.get('source_file')) in changed and e.get('_origin')=='ast') and e['source'] in nodes and e['target'] in nodes]
        edges.extend(e for e in fresh['edges'] if e['source'] in nodes and e['target'] in nodes)
        data['nodes']=list(nodes.values());data[edge_key]=edges
        report=dict(utc=datetime.now(timezone.utc).isoformat(),mode='bounded AST extraction and source-scoped merge',
                    sources={p.relative_to(workspace).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in changes},
                    nodes_before=old_count,nodes_after=len(nodes),fresh_nodes=len(fresh['nodes']),fresh_edges=len(fresh['edges']),
                    input_tokens=0,output_tokens=0,unmodified_graph_preserved=True,clustering_refreshed=False,cli_update=cli_status)
        temporary=graph.with_suffix('.tkk.tmp')
        with temporary.open('w',encoding='utf8') as stream:
            json.dump(data,stream,ensure_ascii=False,separators=(',',':'))
        if graph.stat().st_mtime_ns!=before.st_mtime_ns or graph.stat().st_size!=before.st_size:
            raise RuntimeError('Graph changed concurrently; temporary result was not applied')
        temporary.replace(graph)
        (graph.parent/f'tkk_{args.release_tag}_update.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps({k:v for k,v in report.items() if k!='sources'},ensure_ascii=False,indent=2))
