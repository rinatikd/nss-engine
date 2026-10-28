import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import tunnel_connector as c
from tunnel_mcp_entry import scrub_credentials


class TunnelConnectorTests(unittest.TestCase):
    def test_profile_binds_stdio_to_same_absolute_database_and_reference_only(self):
        with tempfile.TemporaryDirectory(prefix='a2a source space ') as folder:
            source = str(Path(folder));db = str(Path(folder) / 'state' / 'a.sqlite')
            profile = c.build_profile(db, source, '/usr/bin/python3', 'tunnel_00000000000000000000000000000000')
            obj = json.loads(profile)
            self.assertEqual(obj['control_plane']['api_key'], 'env:CONTROL_PLANE_API_KEY')
            self.assertEqual(obj['health']['listen_addr'], '127.0.0.1:0')
            import shlex
            args = shlex.split(obj['mcp']['commands'][0]['command'])
            self.assertEqual(args[-1], db)
            self.assertEqual(args[2], str(Path(source) / 'tunnel_mcp_entry.py'))
            self.assertFalse(obj['admin_ui']['open_browser'])

    def test_exact_supported_namespaced_identifier_is_preserved(self):
        tunnel='tunnel_a1b2_'+'z9'*16
        self.assertEqual(json.loads(c.build_profile('/tmp/a.sqlite','/tmp','/usr/bin/python',tunnel))['control_plane']['tunnel_id'],tunnel)

    def test_optional_local_codex_profile_binds_only_explicit_native_path_and_model(self):
        import shlex
        with tempfile.TemporaryDirectory(prefix='native codex space ') as folder:
            root=Path(folder);native=root/'codex native';native.write_bytes(b'\x7fELF-fixture-never-executed');native.chmod(0o700)
            profile=json.loads(c.build_profile(str(root/'db.sqlite'),str(root),'/usr/bin/python','tunnel_'+'0'*32,
                                               codex_executable=str(native),codex_model='qwen2.5:7b'))
            command=shlex.split(profile['mcp']['commands'][0]['command'])
            self.assertEqual(command[-4:],['--codex-executable',str(native),'--codex-model','qwen2.5:7b'])
            default=json.loads(c.build_profile(str(root/'db.sqlite'),str(root),'/usr/bin/python','tunnel_'+'0'*32))
            self.assertNotIn('--codex-executable',default['mcp']['commands'][0]['command'])
            # Existing prepared profiles cannot silently gain a different backend/model.
            self.assertNotEqual(profile,default)

    def test_local_codex_rejects_nonlinux_wrappers_links_and_unpinned_models(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);native=root/'codex';native.write_bytes(b'\x7fELF-fixture');native.chmod(0o700)
            wrapper=root/'codex.sh';wrapper.write_text('#!/bin/sh\nexit 0');wrapper.chmod(0o700)
            link=root/'linked';link.symlink_to(native)
            for path in (str(wrapper),str(link),'relative-codex',str(root/'missing')):
                with self.subTest(path=path), self.assertRaises(ValueError):c.codex_arguments(path)
            with patch('tunnel_connector.platform.system',return_value='Windows'), self.assertRaises(ValueError):
                c.codex_arguments(str(native))
            for model in ('gpt-cloud','qwen2.5:3b --yolo','qwen2.5:7b'):
                with self.subTest(model=model), self.assertRaises(ValueError):c.codex_arguments(None,model)
            with self.assertRaises(ValueError):c.codex_arguments(str(native),'other-local-model')

    def test_relative_or_missing_identifier_fails_before_writing(self):
        for tunnel in ('', 'REPLACE_WITH_REAL_TUNNEL_ID', 'tunnel_synthetic_fixture',
                       'tunnel_'+'A'*32, 'tunnel_xxx_'+'0'*32, 'tunnel_xxxxx_'+'0'*32, 'tunnel_'+'0'*31):
            with self.assertRaises(ValueError):c.build_profile('/tmp/test.sqlite', '/tmp', '/usr/bin/python', tunnel)
        with self.assertRaises(ValueError):
            c.build_profile('relative.sqlite', '/tmp', '/usr/bin/python', 'tunnel_00000000000000000000000000000000')

    def test_existing_profile_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'profile.yaml'
            c.prepare(path, 'original')
            with self.assertRaises(FileExistsError):c.prepare(path, 'changed')
            self.assertEqual(path.read_text(), 'original')

    def test_missing_key_blocks_but_never_returns_supplied_value(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);client=root/'client';client.write_text('fake');profile=root/'p.yaml';c.prepare(profile,'expected')
            runner=lambda *a, **k:subprocess.CompletedProcess(a[0],0,'tunnel-client version 0.0.18','')
            missing=c.inspect(str(client),str(profile),'expected',{},runner)
            self.assertEqual(missing['state'],'BLOCKED')
            ready=c.inspect(str(client),str(profile),'expected',{'CONTROL_PLANE_API_KEY':'TEST-SECRET-NOT-PRINTED'},runner)
            self.assertEqual(ready['state'],'LOCAL_PREREQUISITES_READY')
            self.assertNotIn('TEST-SECRET',json.dumps(ready))
            self.assertFalse(ready['chatgpt_app_verified']);self.assertFalse(ready['binary_publisher_verified'])

    def test_modified_profile_and_wrong_version_are_blocked(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);client=root/'client';client.write_text('fake');profile=root/'p.yaml';c.prepare(profile,'changed')
            runner=lambda *a, **k:subprocess.CompletedProcess(a[0],0,'0.0.19','')
            result=c.inspect(str(client),str(profile),'expected',{'CONTROL_PLANE_API_KEY':'fixture'},runner)
            self.assertFalse(result['checks']['profile_matches']);self.assertFalse(result['checks']['client_version'])
            self.assertEqual(result['state'],'BLOCKED')

    def test_ambient_settings_cannot_replace_profile_or_enable_remote_ui(self):
        env={'PATH':'fixture','HTTPS_PROXY':'http://session-proxy', 'CONTROL_PLANE_API_KEY':'fixture-secret',
             'CONTROL_PLANE_BASE_URL':'https://other.invalid','MCP_COMMAND':'wrong', 'ALLOW_REMOTE_UI':'true',
             'OPENAI_ADMIN_KEY':'adminfixture','TUNNEL_CLIENT_CONFIG':'other.yaml','LOG_HTTP_RAW_UNSAFE':'true'}
        clean=c.runtime_environment(env)
        self.assertEqual(clean,{'PATH':'fixture','HTTPS_PROXY':'http://session-proxy','CONTROL_PLANE_API_KEY':'fixture-secret'})

    def test_ambient_rpc_binding_cannot_enable_codex_when_profile_omits_it(self):
        env = {'PATH': 'fixture', 'HTTPS_PROXY': 'http://session-proxy',
               'A2A_CODEX_RPC_URL': 'http://127.0.0.1:12345/',
               'A2A_CODEX_RPC_TOKEN': 'TEST-ambient-backend-token'}
        self.assertEqual(c.runtime_environment(env),
                         {'PATH': 'fixture', 'HTTPS_PROXY': 'http://session-proxy'})
        self.assertEqual(scrub_credentials(env),
                         {'PATH': 'fixture', 'HTTPS_PROXY': 'http://session-proxy'})

    def test_mcp_child_receives_no_tunnel_or_openai_credentials(self):
        env={'CONTROL_PLANE_API_KEY':'runtime-fixture','OPENAI_API_KEY':'fixture','OPENAI_ADMIN_KEY':'adminfixture',
             'PATH':'fixture','HTTPS_PROXY':'http://session-proxy'}
        self.assertEqual(scrub_credentials(env),{'PATH':'fixture','HTTPS_PROXY':'http://session-proxy'})

    def test_real_entrypoint_strips_credentials_before_importing_runtime(self):
        import os
        import shutil
        import sys
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            shutil.copy2(Path(__file__).with_name('tunnel_mcp_entry.py'),root/'tunnel_mcp_entry.py')
            shutil.copy2(Path(__file__).with_name('tunnel_connector.py'),root/'tunnel_connector.py')
            (root/'run_workspace.py').write_text("import os,json,sys\nprint(json.dumps({'keys_present':[k for k in ('CONTROL_PLANE_API_KEY','OPENAI_API_KEY','OPENAI_ADMIN_KEY','A2A_CODEX_RPC_URL','A2A_CODEX_RPC_TOKEN') if k in os.environ],'args':sys.argv[1:]}))\n")
            env=dict(os.environ,CONTROL_PLANE_API_KEY='TEST-fixture-runtime',OPENAI_API_KEY='TEST-fixture-api',OPENAI_ADMIN_KEY='TEST-fixture-admin',A2A_CODEX_RPC_URL='http://127.0.0.1:12345/',A2A_CODEX_RPC_TOKEN='TEST-ambient-backend-token')
            result=subprocess.run([sys.executable,str(root/'tunnel_mcp_entry.py'),'--db',str(root/'db.sqlite'),'--ui-port','0'],env=env,capture_output=True,text=True,check=True,timeout=10)
            response=json.loads(result.stdout)
            self.assertEqual(response['keys_present'],[])
            self.assertEqual(response['args'],['--transport','stdio','--ui-port','0','--db',str(root/'db.sqlite')])
            self.assertNotIn('fixture-runtime',result.stdout)

    def test_real_entrypoint_forwards_optional_codex_binding_to_workspace(self):
        import os
        import shutil
        import sys
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name in ('tunnel_mcp_entry.py','tunnel_connector.py'):
                shutil.copy2(Path(__file__).with_name(name),root/name)
            (root/'run_workspace.py').write_text("import json,sys\nprint(json.dumps(sys.argv[1:]))\n")
            native=root/'codex native';native.write_bytes(b'\x7fELF-fixture');native.chmod(0o700)
            args=[sys.executable,str(root/'tunnel_mcp_entry.py'),'--db',str(root/'db.sqlite'),
                  '--codex-executable',str(native),'--codex-model','qwen2.5:7b']
            result=subprocess.run(args,capture_output=True,text=True,check=True,timeout=10)
            forwarded=json.loads(result.stdout)
            self.assertEqual(forwarded[-4:],['--codex-executable',str(native),'--codex-model','qwen2.5:7b'])
            self.assertEqual(forwarded[:2],['--transport','stdio'])

    def test_hidden_key_is_only_in_child_environment_not_arguments_or_report(self):
        import io
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder);(source/'run_workspace.py').write_text('fixture');(source/'tunnel_mcp_entry.py').write_text('fixture')
            args=['doctor','--client',str(source/'client'),'--db',str(source/'db.sqlite'),'--profile-dir',str(source/'profiles'),'--prompt-key']
            ready={'state':'LOCAL_PREREQUISITES_READY'}
            with patch.object(c,'__file__',str(source/'tunnel_connector.py')), patch.dict(c.os.environ,{'CONTROL_PLANE_TUNNEL_ID':'tunnel_00000000000000000000000000000000'},clear=True), patch.object(c.sys.stdin,'isatty',return_value=True), patch.object(c.getpass,'getpass',return_value='TEST-HIDDEN-RUNTIME'), patch.object(c,'inspect',return_value=ready), patch.object(c.subprocess,'run',return_value=subprocess.CompletedProcess([],0)) as run, patch('sys.stdout',new_callable=io.StringIO) as output:
                self.assertEqual(c.main(args),0)
                self.assertEqual(run.call_args.kwargs['env']['CONTROL_PLANE_API_KEY'],'TEST-HIDDEN-RUNTIME')
                self.assertNotIn('TEST-HIDDEN-RUNTIME',str(run.call_args.args))
                self.assertNotIn('TEST-HIDDEN-RUNTIME',output.getvalue())

    def test_noninteractive_key_prompt_refuses_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder);(source/'run_workspace.py').write_text('fixture');(source/'tunnel_mcp_entry.py').write_text('fixture')
            args=['run','--client',str(source/'client'),'--db',str(source/'db.sqlite'),'--profile-dir',str(source/'profiles'),'--prompt-key']
            with patch.object(c,'__file__',str(source/'tunnel_connector.py')), patch.dict(c.os.environ,{'CONTROL_PLANE_TUNNEL_ID':'tunnel_00000000000000000000000000000000'},clear=True), patch.object(c.sys.stdin,'isatty',return_value=False), patch.object(c.getpass,'getpass') as prompt, patch.object(c.subprocess,'call') as run, patch('builtins.print'):
                self.assertEqual(c.main(args),2);prompt.assert_not_called();run.assert_not_called()

    def test_run_without_key_never_starts_daemon(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder);(source/'run_workspace.py').write_text('fixture');(source/'tunnel_mcp_entry.py').write_text('fixture')
            client=source/'client';client.write_text('fixture')
            args=['run','--client',str(client),'--db',str(source/'db.sqlite'),'--profile-dir',str(source/'profiles')]
            with patch.object(c,'__file__',str(source/'tunnel_connector.py')), patch.dict(c.os.environ,{'CONTROL_PLANE_TUNNEL_ID':'tunnel_00000000000000000000000000000000'},clear=True), patch.object(c.subprocess,'call') as run, patch('builtins.print'):
                self.assertEqual(c.main(args),2);run.assert_not_called()


if __name__=='__main__':unittest.main()
