#!/usr/bin/env python3
"""
Turns the display kiosk's screen on and off for the weather display's bedtime
mode, on the Raspberry Pi showing it. The page calls it from the kiosk's own
browser (it only answers on this Pi, at 127.0.0.1):

- GET  /display      -> {"on": true or false}
- POST /display/on   -> turns the screen on
- POST /display/off  -> turns the screen off

The screen is switched with `vcgencmd display_power`, which turns the HDMI
signal off; the touchscreen keeps working, so a tap can wake it. The screen is
turned on when this starts, so a restart or reboot never leaves it dark.

Installed as a system service on the kiosk Pi (see display-power.service).
"""
import json
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8770


def set_display(on):
    subprocess.run(['vcgencmd', 'display_power', '1' if on else '0'], check=True, stdout=subprocess.DEVNULL)


def display_is_on():
    output = subprocess.run(['vcgencmd', 'display_power'], check=True, stdout=subprocess.PIPE).stdout
    return output.decode().strip().endswith('=1')


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body=None):
        data = json.dumps(body if body is not None else {}).encode()
        self.send_response(status)
        # The page comes from the weather server, so it needs permission to call here
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.respond(204)

    def do_GET(self):
        if self.path == '/display':
            self.respond(200, {'on': display_is_on()})
        else:
            self.respond(404, {'error': 'Not found'})

    def do_POST(self):
        if self.path in ('/display/on', '/display/off'):
            set_display(self.path.endswith('/on'))
            self.respond(200, {'on': display_is_on()})
        else:
            self.respond(404, {'error': 'Not found'})

    def log_message(self, format, *args):
        pass


if __name__ == '__main__':
    set_display(True)
    HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
