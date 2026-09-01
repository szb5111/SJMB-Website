"""Dev server for the site. Sends no-store so iterative CSS/JS edits show up
immediately, and the right MIME types for .mjs/.woff2."""
import http.server, socketserver, functools, sys
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()
    def log_message(self, *a): pass
H.extensions_map.update({'.js':'text/javascript', '.mjs':'text/javascript', '.woff2':'font/woff2'})
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", port), functools.partial(H, directory=".")) as s:
    s.serve_forever()
