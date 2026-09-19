import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

OS_API = "https://opensky-network.org/api/states/all"


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/states":
            self.proxy_states(parsed.query)
        else:
            super().do_GET()

    def proxy_states(self, query):
        try:
            qs = parse_qs(query)
            flat = {k: v[0] for k, v in qs.items()}
            url = OS_API + "?" + urlencode(flat)
            req = Request(
                url,
                headers={
                    "User-Agent": "flytrack/1.0",
                    "Accept": "application/json",
                },
            )
            with urlopen(req, timeout=60) as r:
                body = r.read()
            self.forward(200, body, extra_headers={"Cache-Control": "no-store"})
        except HTTPError as e:
            body = e.read()
            retry = e.headers.get("Retry-After")
            headers = {}
            if retry:
                headers["Retry-After"] = retry
            self.forward(e.code, body, extra_headers=headers)
        except Exception as e:
            body = json.dumps({"error": str(e)}).encode()
            self.forward(502, body)

    def forward(self, status, body, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"FlyTrack serving on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()