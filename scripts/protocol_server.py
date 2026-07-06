"""协议执行器 HTTP 服务 - 在宿主机上运行（多线程）"""
import json, sys, logging, traceback, io
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from claude_protocol.console_flow import ConsoleArgs, run_console_flow

PORT = 9876

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/run":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length > 0 else {}

        # Capture logs for this request
        log_stream = io.StringIO()
        log_handler = logging.StreamHandler(log_stream)
        log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S"))
        root_logger = logging.getLogger()
        root_logger.addHandler(log_handler)
        root_logger.setLevel(logging.INFO)

        try:
            args = ConsoleArgs(
                email=body.get("email", ""),
                password=body.get("password", ""),
                email_source=body.get("email_source", "mailcom"),
                outlook_client_id=body.get("outlook_client_id", ""),
                outlook_refresh_token=body.get("outlook_refresh_token", ""),
                card_number=body.get("card_number", ""),
                card_expiry=body.get("card_expiry", ""),
                card_cvv=body.get("card_cvv", ""),
                amount=float(body.get("amount", 5)),
                proxy=body.get("proxy", ""),
                key_name=body.get("key_name", "auto-key"),
                yescaptcha_key=body.get("yescaptcha_key", ""),
                master_url=body.get("master_url", ""),
                master_api_key=body.get("master_api_key", ""),
            )

            result = run_console_flow(args)

            resp = {
                "success": result.success,
                "key": result.api_key,
                "email": args.email,
                "balance": result.amount,
                "org_id": result.org_id,
                "error": result.error,
                "log": log_stream.getvalue(),
            }
        except Exception as e:
            traceback.print_exc()
            resp = {"success": False, "error": str(e), "email": body.get("email", ""), "log": log_stream.getvalue()}
        finally:
            root_logger.removeHandler(log_handler)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(resp).encode())

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    print(f"Protocol server listening on :{port}")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    class ThreadedServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True
    ThreadedServer(("0.0.0.0", port), Handler).serve_forever()
