"""Launch GeneForge: start the server, then show it in a window."""
from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import time
import urllib.request

DEFAULT_PORT = 8731


def free_port(preferred: int) -> int:
    for port in [preferred] + list(range(preferred + 1, preferred + 40)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return preferred


def wait_until_up(url: str, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.15)
    return False


def main(argv: list[str] | None = None) -> int:
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(prog="geneforge", description="GeneForge sequence workbench")
    parser.add_argument("--folder", default=os.environ.get("GENEFORGE_FOLDER") or os.path.dirname(here),
                        help="folder of sequence files to work in")
    parser.add_argument("--port", type=int, default=int(os.environ.get("GENEFORGE_PORT", DEFAULT_PORT)))
    parser.add_argument("--browser", action="store_true", help="open in the default browser instead of a window")
    parser.add_argument("--headless", action="store_true", help="serve only; open nothing")
    parser.add_argument("--autosave", action="store_true",
                        help="write edits back to disk automatically (off by default)")
    args = parser.parse_args(argv)

    folder = os.path.abspath(os.path.expanduser(args.folder))
    if not os.path.isdir(folder):
        print(f"geneforge: no such folder: {folder}", file=sys.stderr)
        return 2

    import uvicorn
    from .server import create_app
    from .store import Store

    store = Store(folder, autosave=args.autosave)
    app = create_app(store)
    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}"

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    if not wait_until_up(f"{url}/api/health"):
        print("geneforge: server did not start", file=sys.stderr)
        return 1

    print(f"GeneForge is running at {url}")
    print(f"Working folder: {folder}")

    # Nothing is opened automatically. Files are opened only when the user
    # drags one in or picks one from the browser.

    if args.headless:
        try:
            thread.join()
        except KeyboardInterrupt:
            pass
        return 0

    if not args.browser:
        try:
            import webview  # pywebview
            window = webview.create_window("GeneForge", url, width=1500, height=950,
                                           min_size=(1100, 700))
            webview.start()
            return 0
        except Exception as exc:
            print(f"geneforge: native window unavailable ({exc}); opening a browser tab", file=sys.stderr)

    import webbrowser
    webbrowser.open(url)
    try:
        thread.join()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
