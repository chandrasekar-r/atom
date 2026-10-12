#!/usr/bin/env python3
"""Drive `atom` through a real pseudo-terminal, emulate the screen with pyte, record an asciicast v2."""
import os, pty, re, select, sys, time, json, signal, struct, fcntl, termios
import pyte

class Term:
    def __init__(self, argv, cwd, env, cols=110, rows=36, cast=None):
        self.cols, self.rows = cols, rows
        self.screen = pyte.Screen(cols, rows); self.stream = pyte.ByteStream(self.screen)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd); os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.t0 = time.time(); self.raw = b""
        self.cast = open(cast, "w") if cast else None
        if self.cast: self.cast.write(json.dumps({"version": 2, "width": cols, "height": rows, "timestamp": int(self.t0), "env": {"TERM": "xterm-256color"}}) + "\n")
    def pump(self, t=0.05):
        r, _, _ = select.select([self.fd], [], [], t)
        if r:
            try: d = os.read(self.fd, 65536)
            except OSError: return False
            self.raw += d; self.stream.feed(d)
            if self.cast: self.cast.write(json.dumps([round(time.time() - self.t0, 4), "o", d.decode("utf8", "replace")]) + "\n")
        return True
    def text(self): return "\n".join(l.rstrip() for l in self.screen.display)
    def history_text(self):
        return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", self.raw.decode("utf8", "replace"))
    def expect(self, pat, timeout=180, where="screen"):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.1)
            hay = self.text() if where == "screen" else self.history_text()
            m = re.search(pat, hay)
            if m: return m
        raise AssertionError(f"timeout waiting for {pat!r}\n--- screen ---\n{self.text()}")
    def send(self, s, delay=0.03):
        if isinstance(s, str): s = s.encode()
        os.write(self.fd, s)
        if self.cast: self.cast.write(json.dumps([round(time.time() - self.t0, 4), "i", s.decode("utf8", "replace")]) + "\n")
        t = time.time() + delay
        while time.time() < t: self.pump(0.01)
    def type(self, s):
        for ch in s: self.send(ch, 0.01)
    def settle(self, t=0.6):
        end = time.time() + t
        while time.time() < end: self.pump(0.05)
    def snap(self, path):
        with open(path, "w") as f: f.write(self.text() + "\n")
    def close(self):
        try: os.kill(self.pid, signal.SIGTERM)
        except Exception: pass
        if self.cast: self.cast.close()
