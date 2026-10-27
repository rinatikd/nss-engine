"""Run one shared UI/MCP owner with an optional Linux local-only Codex service."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import platform
import secrets
import selectors
import signal
import shutil
import subprocess
import sys

ENV_KEYS=('PATH','HOME','LANG','LC_ALL','TMPDIR','TEMP','TMP','HTTP_PROXY','HTTPS_PROXY',
          'http_proxy','https_proxy','NO_PROXY','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR',
          'REQUESTS_CA_BUNDLE')


class LocalCodexService:
    """Own a fixed sibling service; bearer exists only in parent/child memory."""
    def __init__(self, *, executable, db, model='qwen2.5:3b', node=None, entry=None):
        self.executable=Path(executable)
        self.db=Path(db)
        self.model=model
        self.node=node or shutil.which('node')
        self.entry=Path(entry) if entry else Path(__file__).resolve().parent.parent/'a2a-js-v040-reviewed/src/local-service.mjs'
        self.process=None
        self.endpoint=None
        self.token=secrets.token_urlsafe(32)
        if platform.system()!='Linux':
            raise ValueError('Local Codex service is verified only on Linux; Windows gate remains closed')
        if not self.executable.is_absolute() or not self.executable.is_file() or not self.db.is_absolute():
            raise ValueError('Absolute existing Codex executable and absolute SQLite path required')
        if not self.node or not Path(self.node).is_absolute() or not self.entry.is_absolute() or not self.entry.is_file():
            raise ValueError('Node and fixed sibling service are required')
        if model not in ('qwen2.5:3b','qwen2.5:7b'):
            raise ValueError('Pinned local Qwen model required')

    def start(self):
        if self.process is not None:
            raise RuntimeError('Service was already started')
        env={k:v for k,v in os.environ.items() if k in ENV_KEYS}
        env.update(A2A_CODEX_EXECUTABLE=str(self.executable), A2A_DB=str(self.db),
                   A2A_CODEX_MODEL=self.model, A2A_API_TOKEN=self.token)
        self.process=subprocess.Popen([self.node,str(self.entry)],stdin=subprocess.DEVNULL,
                                      stdout=subprocess.PIPE,stderr=sys.stderr,env=env,
                                      text=True,bufsize=1,start_new_session=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(self.process.stdout,selectors.EVENT_READ)
                if not selector.select(timeout=12):
                    raise RuntimeError('Local service startup timed out')
                line=self.process.stdout.readline(4096)
            info=json.loads(line)
            port=info.get('port')
            if type(port) is not int or not 1<=port<=65535:
                raise ValueError('Invalid local service handshake')
            self.endpoint='http://127.0.0.1:'+str(port)+'/'
            return self
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.process is None:
            return
        if self.process.poll() is None:
            # Node's SIGTERM aborts its active native CLI process group, waits
            # for UNKNOWN to be committed, then closes the ledger/listener.
            self.process.terminate()
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired as exc:
                # No blind SIGKILL: killing the scheduler first could orphan a
                # detached native CLI. Surface failure, leaving process ownership explicit.
                raise RuntimeError('Local service did not acknowledge bounded shutdown') from exc
        if self.process.stdout:
            self.process.stdout.close()

    def __enter__(self):
        return self.start()

    def __exit__(self,*exc):
        self.close()


@contextlib.contextmanager
def client_environment(service):
    names=('A2A_CODEX_RPC_URL','A2A_CODEX_RPC_TOKEN')
    previous={name:os.environ.get(name) for name in names}
    os.environ[names[0]]=service.endpoint
    os.environ[names[1]]=service.token
    try:
        yield
    finally:
        for name,value in previous.items():
            if value is None:os.environ.pop(name,None)
            else:os.environ[name]=value


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',required=True)
    parser.add_argument('--ui-port',type=int,default=8765)
    parser.add_argument('--mcp-port',type=int,default=8766)
    parser.add_argument('--transport',choices=('stdio','streamable-http'),default='stdio')
    parser.add_argument('--codex-executable',help='Optional absolute tested0.163 native executable; Linux local model only')
    parser.add_argument('--codex-model',choices=('qwen2.5:3b','qwen2.5:7b'),default='qwen2.5:3b')
    args=parser.parse_args(argv)
    db=Path(args.db)
    if not db.is_absolute():parser.error('Absolute SQLite path required')
    from unified_runtime import main as unified_main
    runtime_args=['--db',str(db),'--ui-port',str(args.ui_port),'--mcp-port',str(args.mcp_port),'--transport',args.transport]
    if args.codex_executable is None:
        unified_main(runtime_args)
        return 0
    previous_term = signal.getsignal(signal.SIGTERM)
    def terminate(signum, frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate)
    try:
        with LocalCodexService(executable=args.codex_executable,db=db.with_name(db.stem+'-codex.sqlite'),model=args.codex_model) as service:
            with client_environment(service):
                print('A2A local Codex text service connected; actual task completion establishes inference.',file=sys.stderr,flush=True)
                unified_main(runtime_args)
        return 0
    except KeyboardInterrupt:
        return 0
    except (OSError,ValueError,RuntimeError):
        print('A2A local Codex startup/shutdown failed; inspect local prerequisites without sharing secrets.',file=sys.stderr)
        return 2
    finally:
        signal.signal(signal.SIGTERM, previous_term)


if __name__=='__main__':
    raise SystemExit(main())
