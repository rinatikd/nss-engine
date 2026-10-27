"""One loopback UI and MCP owner: both interfaces control the same worker."""
import argparse
from pathlib import Path
import sys
import threading
import webbrowser

from mcp_bridge import create_bridge
from web_app import Application, make_server


class UnifiedRuntime:
    """Own both interfaces and the shared application's lifetime.

    This is a single-process owner. Starting a separate web_app or mcp_bridge
    against the same database does not join this runtime's worker control.
    """
    def __init__(self, db, *, ui_port=8765, mcp_port=8766):
        self.app = Application(db)
        self.server = None
        self.ui_thread = None
        self.closed = False
        try:
            self.server = make_server(self.app, ui_port)
            self.bridge, shared = create_bridge(db, mcp_port, application=self.app)
            assert shared is self.app
        except BaseException:
            self.close()
            raise

    @property
    def ui_address(self):
        return "http://127.0.0.1:" + str(self.server.server_port)

    def start_ui(self):
        if self.closed:
            raise RuntimeError("Runtime is already closed")
        if self.ui_thread is None:
            self.ui_thread = threading.Thread(target=self.server.serve_forever,
                                              name="a2a-local-ui", daemon=True)
            self.ui_thread.start()
        return self.ui_address

    def close(self):
        if self.closed:
            return
        self.closed = True
        # Stop accepting mutations before stopping the worker.
        if self.ui_thread is not None:
            self.server.shutdown()
            self.ui_thread.join(timeout=5)
        if self.server is not None:
            self.server.server_close()
        self.app.close()

    def __enter__(self):
        self.start_ui()
        return self

    def __exit__(self, *exc):
        self.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(Path(__file__).parent / "state" / "interface.sqlite"))
    parser.add_argument("--ui-port", type=int, default=8765)
    parser.add_argument("--mcp-port", type=int, default=8766)
    parser.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio")
    parser.add_argument("--open", action="store_true", help="Open the local UI in a browser")
    args = parser.parse_args(argv)
    for value in (args.ui_port, args.mcp_port):
        if not 0 <= value <= 65535:
            parser.error("Ports must be between 0 and 65535")
    try:
        runtime = UnifiedRuntime(args.db, ui_port=args.ui_port, mcp_port=args.mcp_port)
    except OSError:
        parser.error("Cannot bind the local UI port; stop the existing owner or choose another port")
    try:
        address = runtime.start_ui()
        # stdio stdout is reserved exclusively for MCP protocol messages.
        print("A2A shared UI/MCP runtime: " + address, file=sys.stderr, flush=True)
        if args.open:
            webbrowser.open(address)
        runtime.bridge.run(transport=args.transport)
    finally:
        runtime.close()


if __name__ == "__main__":
    main()
