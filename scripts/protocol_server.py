"""协议执行器 HTTP 服务 - 在宿主机上运行，接收 z-manage 的请求执行协议脚本"""
import json, subprocess, sys, os, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

SCRIPT_PATH = str(Path(__file__).parent / "claude_protocol.py")
PORT = 9876

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/run":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length > 0 else {}

        args = ["python3", SCRIPT_PATH]
        for k, v in body.items():
            if v is not None and v != "":
                args.extend([f"--{k.replace('_', '-')}", str(v)])

        try:
            proc = subprocess.run(args, capture_output=True, text=True, timeout=600, cwd=str(Path(__file__).parent.parent))
            last_line = proc.stdout.strip().split("\n")[-1] if proc.stdout else ""
            try:
                result = json.loads(last_line)
            except Exception:
                result = {"success": False, "error": f"exit {proc.returncode}: {proc.stderr[-200:] if proc.stderr else 'no output'}"}

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        except subprocess.TimeoutExpired:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": False, "error": "timeout 10min"}).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode())

    def log_message(self, format, *args):
        pass  # quiet

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    print(f"Protocol server listening on :{port}")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
