"""HTTPS fixture server for the URL-import positive e2e test.

Serves e2e/fixtures/ (recipe.html) over TLS with CORS headers, so the
app's WebView can fetch it without mixed-content or CORS failures.
Certs are machine-level (NOT committed): /home/devbox/tools/android-emu/fixture-certs/
  ca.crt / ca.key        - test CA; ca.crt is installed in the emulator's
                           /system/etc/security/cacerts (one-time setup)
  server.crt / server.key - serves 10.0.2.2 (SAN IP:10.0.2.2)

Usage: serve-https.py [cert-dir] [port]   (defaults: the path above, 8443)
"""
import os
import ssl
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

CERT_DIR = sys.argv[1] if len(sys.argv) > 1 else "/home/devbox/tools/android-emu/fixture-certs"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8443

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__))))


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args):
        pass


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(os.path.join(CERT_DIR, "server.crt"), os.path.join(CERT_DIR, "server.key"))
server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
server.socket = ctx.wrap_socket(server.socket, server_side=True)
print(f"fixture https on :{PORT}", flush=True)
server.serve_forever()
