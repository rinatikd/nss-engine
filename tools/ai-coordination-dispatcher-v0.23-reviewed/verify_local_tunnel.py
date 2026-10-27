"""Explicit Linux-only official dev-proxy fixture; never a hosted ChatGPT connection."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from tunnel_connector import build_profile, runtime_environment


async def exchange(url):
    parsed=urlparse(url)
    if parsed.scheme!='http' or parsed.hostname!='127.0.0.1':
        raise ValueError('The fixture accepts only the owned loopback HTTP endpoint')
    async with streamablehttp_client(url,timeout=__import__('datetime').timedelta(seconds=15)) as (read,write,_):
        async with ClientSession(read,write) as session:
            await session.initialize()
            tools=await session.list_tools()
            async def call(name,args):
                reply=await session.call_tool(name,args)
                if reply.isError or reply.structuredContent is None:
                    raise ValueError('Local tunneled tool failed: '+name)
                return reply.structuredContent
            health=await call('dispatcher_health',{})
            if health['paid_api_allowed'] is not False:
                raise ValueError('Paid policy changed')
            request='0'*32
            submitted=await call('dispatcher_submit_task',{'request_id':request,'prompt':'Synthetic local transport fixture only','rubric':'No inference required','max_revisions':0})
            task_id=submitted['task_id']
            status=await call('dispatcher_get_task',{'task_id':task_id})
            if status['state']!='QUEUED':raise ValueError('Unexpected fixture state')
            if 'spec' in status or 'attempts' in status:raise ValueError('Private task requests exposed')
            cancelled=await call('dispatcher_cancel_task',{'task_id':task_id})
            if cancelled['state']!='CANCELLED':raise ValueError('Cancellation not persisted')
            return {'passed':True,'tools_count':len(tools.tools),'task_state':cancelled['state'],
                    'official_tunnel_transport_verified':True,'hosted_tunnel_verified':False,
                    'chatgpt_app_verified':False,'model_calls':0,'paid_api_calls':0}


def verify(client,source,timeout=40):
    if os.name!='posix':raise ValueError('This bounded process-group fixture is verified only on POSIX')
    client=Path(client);source=Path(source)
    if not client.is_absolute() or not client.is_file() or not source.is_absolute():
        raise ValueError('Absolute existing client/source required')
    with tempfile.TemporaryDirectory(prefix='a2a-official-local-tunnel-') as folder:
        root=Path(folder);profile=root/'profile.yaml';connection=root/'connection';logs=root/'private.log'
        profile.write_text(build_profile(str(root/'fixture.sqlite'),str(source),sys.executable,'tunnel_'+'0'*32,0))
        # No API/administrative credential is provided. dev proxy owns an in-memory local control plane.
        env=runtime_environment(os.environ)
        env.pop('CONTROL_PLANE_API_KEY',None)
        command=[str(client),'dev','proxy','--backend','go','--profile-file',str(profile),
                 '--listen','127.0.0.1:0','--url-file',str(connection),
                 '--duration',str(timeout)+'s','--readiness-timeout','15s','--response-timeout','15s']
        with logs.open('wb') as output:
            process=subprocess.Popen(command,env=env,stdout=output,stderr=output,start_new_session=True)
            try:
                deadline=time.monotonic()+min(20,timeout)
                while not connection.exists():
                    if process.poll() is not None:raise RuntimeError('Local dev proxy exited before readiness')
                    if time.monotonic()>=deadline:raise TimeoutError('Local dev proxy readiness timeout')
                    time.sleep(0.1)
                info=json.loads(connection.read_text())
                # Return no generated credentials or raw private diagnostics.
                url=info.get('mcp_url') or info.get('mcpUrl') or info.get('url')
                if not isinstance(url,str):
                    raise RuntimeError('Unknown local dev proxy connection format: '+','.join(sorted(info)))
                return asyncio.run(asyncio.wait_for(exchange(url),timeout=max(1,timeout-20)))
            finally:
                try:os.killpg(process.pid,signal.SIGTERM)
                except ProcessLookupError:pass
                try:process.wait(timeout=3)
                except subprocess.TimeoutExpired:pass
                # Terminate any owned descendants that kept the process group after parent exit.
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait(timeout=3)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--client',required=True)
    parser.add_argument('--source',default=str(Path(__file__).resolve().parent))
    parser.add_argument('--timeout',type=int,default=40)
    args=parser.parse_args()
    if not 25<=args.timeout<=60:parser.error('timeout must be 25..60 seconds')
    try:result=verify(args.client,args.source,args.timeout)
    except Exception as exc:
        print(json.dumps({'passed':False,'reason':str(exc),'hosted_tunnel_verified':False,'chatgpt_app_verified':False}))
        return 2
    print(json.dumps(result));return 0


if __name__=='__main__':raise SystemExit(main())
