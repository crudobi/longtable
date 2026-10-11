#!/usr/bin/env python3
"""Request-logging static file server for the Longtable zero-network check.

Serves the production build (run with cwd = dist/) on 127.0.0.1:8765 and
appends every request path to /tmp/lt-requests.log. All responses carry a
long-lived immutable Cache-Control header so the service worker's own update
check can be satisfied from the browser HTTP cache on repeat visits.
"""
import http.server

LOG_PATH = '/tmp/lt-requests.log'
PORT = 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
        super().end_headers()

    def _logged_serve(self):
        with open(LOG_PATH, 'a') as f:
            f.write(self.path.split('?')[0] + '\n')
        super().do_GET()

    do_GET = _logged_serve
    do_HEAD = _logged_serve


if __name__ == '__main__':
    open(LOG_PATH, 'w').close()
    print(f'serving on 127.0.0.1:{PORT}, logging to {LOG_PATH}', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
