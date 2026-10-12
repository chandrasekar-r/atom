#!/usr/bin/env python3
"""TUI end-to-end test through a real pty against real Workers AI. Writes screenshots to evidence/ and an asciicast."""
import os, sys, shutil, tempfile, time, struct, zlib, traceback
sys.path.insert(0, os.path.dirname(__file__)); from tui_drive import Term
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); EV = os.path.join(ROOT, "evidence"); os.makedirs(EV, exist_ok=True)
d = tempfile.mkdtemp(prefix="atom-tui-"); cfg = tempfile.mkdtemp(prefix="atom-cfg-")
open(f"{d}/math.js", "w").write("export const add=(a,b)=>a-b;\n")
open(f"{d}/AGENTS.md", "w").write("# Rules\nAlways end every reply with the token ~agents~.\n")
def png(path, rgb):  # tiny solid-color PNG
    w = h = 32; raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    ch = lambda t, b: struct.pack(">I", len(b)) + t + b + struct.pack(">I", zlib.crc32(t + b))
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b""))
png(f"{d}/red.png", (230, 20, 20))
env = dict(os.environ, ATOM_CONFIG_DIR=cfg, TERM="xterm-256color")
if not env.get("ATOM_GATEWAY_KEY") and os.path.exists(f"{ROOT}/.gateway_key"):
    env.update(ATOM_GATEWAY_URL="https://atom-gateway.rclabs.in", ATOM_GATEWAY_KEY=open(f"{ROOT}/.gateway_key").read().strip())
results = []
def test(name):
    def deco(fn):
        try: fn(); results.append(("PASS", name))
        except Exception as e: results.append(("FAIL", f"{name}: {str(e)[:1500]}"))
        return fn
    return deco
t = Term(["node", f"{ROOT}/bin/atom.js"], d, env, cast=f"{EV}/atom-tui.cast")
ESC, STAB, UP, DOWN = "\x1b", "\x1b[Z", "\x1b[A", "\x1b[B"
def clear(): t.send("\x03"); t.settle(0.2)
def idle(timeout=240):
    end = time.time() + timeout; quiet = None
    while time.time() < end:
        t.pump(0.1)
        if "tokens · esc to interrupt" in t.text() or "to confirm · esc to deny" in t.text(): quiet = None
        elif quiet is None: quiet = time.time()
        elif time.time() - quiet > 2: return
    raise AssertionError("agent did not go idle\n" + t.text())

@test("startup banner + AGENTS.md loaded")
def _(): t.expect(r"Atom v0\.3\.1"); t.expect(r"memory: AGENTS\.md"); t.settle(); t.snap(f"{EV}/01-start.txt")

@test("slash menu autocomplete")
def _():
    t.type("/co"); t.expect(r"❯ /compact"); t.expect(r"/cost"); t.snap(f"{EV}/02-slash-menu.txt"); t.send(ESC); clear()

@test("/model picker: arrow keys + enter select, persisted; partial name + autocomplete")
def _():
    t.type("/model"); t.send("\r"); t.settle(0.3)
    if "Select model" not in t.text(): t.send("\r")  # first enter may only accept the slash-menu item
    t.expect(r"Select model"); t.expect(r"❯ ● gpt-oss-120b"); t.snap(f"{EV}/02b-model-picker.txt")
    t.send(DOWN); t.settle(0.2); t.expect(r"❯\s+gpt-oss-20b"); t.send("\r"); t.expect(r"model → @cf/openai/gpt-oss-20b")
    import json; assert json.load(open(f"{cfg}/settings.json"))["model"] == "@cf/openai/gpt-oss-20b", "not persisted"
    t.type("/model kimi"); t.settle(0.4); t.expect(r"kimi-k2\.7-code"); clear()
    t.type("/model llama-3.3"); t.send("\r"); t.settle(0.3)
    if "model → @cf/meta/llama-3.3" not in t.text(): t.send("\r")
    t.expect(r"model → @cf/meta/llama-3\.3-70b")
    t.type("/model gpt-oss-120b"); t.send("\r"); t.settle(0.3)
    if "model → @cf/openai/gpt-oss-120b" not in t.text(): t.send("\r")
    t.expect(r"model → @cf/openai/gpt-oss-120b")

@test("@ fuzzy file completion")
def _():
    t.type("look at @mth"); t.expect(r"❯ @math\.js"); t.snap(f"{EV}/03-at-file.txt"); t.send("\t"); t.expect(r"look at @math\.js"); clear()

@test("shift+tab cycles permission modes")
def _():
    t.send(STAB); t.expect(r"accept edits on"); t.send(STAB); t.expect(r"plan mode on"); t.snap(f"{EV}/04-plan-mode.txt")
    t.send(STAB); t.expect(r"bypass permissions on"); t.send(STAB); t.expect(r"shift\+tab to cycle modes")

@test("todo tool inline + permission dialog + diff render + streaming markdown")
def _():
    t.type("First call todo_write with two items (find bug, fix bug). Then fix the bug in @math.js using edit_file. Then call todo_write again marking both completed. Finally reply with a short markdown bullet list summary.")
    t.send("\r"); t.expect(r"esc to interrupt", 60); t.snap(f"{EV}/05-spinner.txt")
    t.expect(r"Allow edit_file\?", 240); t.expect(r"Yes, and don't ask again"); t.settle(0.5); t.snap(f"{EV}/06-permission.txt")
    t.send("1"); t.expect(r"⎿  Edited math\.js", 120); t.expect(r"\+ export const add=\(a,b\)=>a\s*\+\s*b", 5, "history")
    t.expect(r"~agents~", 240); idle(); t.snap(f"{EV}/07-edit-diff-todos.txt")
    assert "a+b" in open(f"{d}/math.js").read().replace(" ", ""), open(f"{d}/math.js").read()
    assert "☒" in t.history_text(), "completed todo marker not rendered"

@test("multiline input (backslash-enter) + history")
def _():
    t.type("Repeat these two lines exactly, nothing else: alpha\\"); t.send("\r"); t.type("beta"); t.expect(r"│\s+beta"); t.snap(f"{EV}/08-multiline.txt")
    t.send("\r"); t.expect(r"⏺ alpha\s+beta", 180); idle()
    t.send(UP); t.expect(r"> Repeat these two lines"); clear()

@test("esc interrupts a running turn")
def _():
    t.type("Write a 1500-word essay about the history of rivers. Do not use tools."); t.send("\r")
    t.expect(r"esc to interrupt", 60); time.sleep(4); t.send(ESC); t.expect(r"Interrupted by user", 30); idle(30); t.snap(f"{EV}/09-interrupt.txt")

@test("task subagent tool")
def _():
    t.type("Use the task tool (readonly: true) to have a subagent find which file defines the add function. Then tell me the filename."); t.send("\r")
    t.expect(r"task", 180, "history"); t.expect(r"↳", 180, "history"); idle()
    assert "math.js" in t.history_text().split("task(")[-1], "subagent report missing math.js"; t.snap(f"{EV}/10-subagent.txt")

@test("session tree + branching (esc esc)")
def _():
    t.send(ESC); time.sleep(0.15); t.send(ESC); t.expect(r"Session tree"); t.snap(f"{EV}/11-tree.txt")
    t.send(UP); t.send(UP); t.send("\r"); t.expect(r"Branched: active path now has"); t.expect(r"> Repeat these two lines"); clear()
    t.type("/tree"); t.send("\r"); t.expect(r"Session tree"); t.send(ESC); t.settle(0.3)

@test("image paste (bracketed paste of a png path) with vision model")
def _():
    t.type("/model llama-4-scout"); t.send("\r"); t.expect(r"model → @cf/meta/llama-4-scout")
    t.send("\x1b[200~" + f"{d}/red.png" + "\x1b[201~"); t.expect(r"\[image #1: red\.png\]"); t.expect(r"\[1 image\]")
    t.type("What single color fills this image? One word."); t.snap(f"{EV}/12-image.txt"); t.send("\r")
    idle(); assert __import__("re").search(r"(?i)\bred\b", t.history_text().split("One word.")[-1]), "no red in answer"
    t.type("/model gpt-oss-120b"); t.send("\r"); t.settle(0.5)

@test("/compact")
def _():
    t.type("/compact"); t.send("\r"); t.expect(r"compacting", 30, "history"); idle(); t.expect(r"Summary|summary|goal|Goal|math", 5, "history"); t.snap(f"{EV}/13-compact.txt")

@test("? shortcuts + /cost + exit")
def _():
    t.send("?"); t.expect(r"esc esc\s+session tree"); t.type("/cost"); t.send("\r"); t.expect(r"neurons: \d"); t.snap(f"{EV}/14-final.txt")
    t.send("\x03"); t.send("\x03"); time.sleep(1)

t.close()
open(f"{EV}/transcript.txt", "w").write(t.history_text())
print("\n=== TUI RESULTS ===\n" + "\n".join("  ".join(r) for r in results))
sys.exit(1 if any(r[0] == "FAIL" for r in results) else 0)
