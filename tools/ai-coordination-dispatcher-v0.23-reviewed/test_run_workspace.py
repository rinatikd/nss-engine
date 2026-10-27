import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import shutil
import tempfile
import unittest
from unittest.mock import patch
import urllib.request
from run_workspace import LocalCodexService,client_environment

class WorkspaceLauncherTests(unittest.TestCase):
    def test_owned_service_handshake_env_and_shutdown(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            entry=root/'fixture.mjs'
            entry.write_text("""import http from 'node:http';
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({keys:['CONTROL_PLANE_API_KEY','OPENAI_API_KEY','OPENAI_ADMIN_KEY'].filter(k=>k in process.env),configured:Boolean(process.env.A2A_API_TOKEN)}));});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
process.once('SIGTERM',()=>{server.closeAllConnections();server.close();});
""")
            executable=root/'codex';executable.write_text('fixture only')
            with patch.dict(os.environ,{'CONTROL_PLANE_API_KEY':'TEST-fixture-runtime','OPENAI_API_KEY':'TEST-fixture-api','OPENAI_ADMIN_KEY':'TEST-fixture-admin'}):
                service=LocalCodexService(executable=executable,db=root/'codex.sqlite',entry=entry)
                with service:
                    result=json.load(urllib.request.urlopen(service.endpoint))
                    self.assertEqual(result,{'keys':[],'configured':True})
                    with patch.dict(os.environ,{'A2A_CODEX_RPC_URL':'previous-local-config','A2A_CODEX_RPC_TOKEN':'TEST-previous-value'}):
                        with client_environment(service):
                            self.assertEqual(os.environ['A2A_CODEX_RPC_URL'],service.endpoint)
                            self.assertEqual(os.environ['A2A_CODEX_RPC_TOKEN'],service.token)
                        self.assertEqual(os.environ['A2A_CODEX_RPC_URL'],'previous-local-config')
                    process=service.process
                self.assertIsNotNone(process.poll())
                service.close()
                with self.assertRaises(Exception):urllib.request.urlopen(service.endpoint,timeout=.5)

    def test_parent_sigterm_closes_owned_node_listener(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);py=root/'python';js=root/'a2a-js-v040-reviewed/src';py.mkdir();js.mkdir(parents=True)
            shutil.copy2(Path(__file__).with_name('run_workspace.py'),py/'run_workspace.py')
            marker=root/'node.pid';ready=root/'runtime.ready'
            (js/'local-service.mjs').write_text("import fs from 'node:fs';import http from 'node:http';const s=http.createServer((req,res)=>res.end('fixture'));s.listen(0,'127.0.0.1',()=>{fs.writeFileSync("+json.dumps(str(marker))+",String(process.pid));console.log(JSON.stringify({port:s.address().port}));});process.once('SIGTERM',()=>{s.closeAllConnections();s.close();});")
            (py/'unified_runtime.py').write_text("import pathlib,time\ndef main(args):\n pathlib.Path("+repr(str(ready))+").write_text('ready')\n while True:time.sleep(.1)\n")
            exe=root/'codex';exe.write_text('fixture')
            process=subprocess.Popen([sys.executable,str(py/'run_workspace.py'),'--db',str(root/'db.sqlite'),'--codex-executable',str(exe)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                for _ in range(100):
                    if ready.exists():break
                    time.sleep(.02)
                self.assertTrue(ready.exists())
                node_pid=int(marker.read_text())
                process.terminate();out,err=process.communicate(timeout=5)
                self.assertEqual(process.returncode,0,err)
                self.assertEqual(out,'')
                with self.assertRaises(ProcessLookupError):os.kill(node_pid,0)
            finally:
                if process.poll() is None:process.kill();process.communicate(timeout=3)

    def test_windows_and_remote_configuration_are_not_enabled(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);exe=root/'codex.exe';exe.write_text('fixture')
            with patch('run_workspace.platform.system',return_value='Windows'):
                with self.assertRaises(ValueError):LocalCodexService(executable=exe,db=root/'db.sqlite')
            with self.assertRaises(ValueError):LocalCodexService(executable='relative',db=root/'db.sqlite')
            with self.assertRaises(ValueError):LocalCodexService(executable=exe,db=root/'db.sqlite',model='remote:cloud')

if __name__=='__main__':unittest.main()
