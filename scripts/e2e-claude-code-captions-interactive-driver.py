#!/usr/bin/env python3
"""Run interactive Claude Code in a PTY with an initial prompt until DONE renders or the deadline passes."""
import os, pty, select, signal, struct, subprocess, sys, time, fcntl, termios, re
client, cwd, config, base_url, model, prompt, seconds = sys.argv[1:]
env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE_", "CLAUDECODE", "ANTHROPIC_", "MERIDIAN_"))}
env.update(CLAUDE_CONFIG_DIR=config, ANTHROPIC_BASE_URL=base_url, ANTHROPIC_AUTH_TOKEN="meridian-e2e-dummy", TERM="xterm-256color")
args = [client, "--model", model, "--permission-mode", "default", "--allowedTools", "Bash(echo:*)", "Bash(sleep:*)", "Agent", "--", prompt]
import json
state = os.path.join(config, ".claude.json")
seed = json.load(open(state)) if os.path.exists(state) else {}
seed.update(hasCompletedOnboarding=True, theme="dark", bypassPermissionsModeAccepted=False)
seed.setdefault("projects", {})[cwd] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True, "allowedTools": []}
json.dump(seed, open(state, "w"))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
child = subprocess.Popen(args, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
out = bytearray(); answered = set(); done_at = None
deadline = time.monotonic() + float(seconds)
ansi = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.2)[0]:
            try: chunk = os.read(master, 65536)
            except OSError: break
            if not chunk: break
            out.extend(chunk)
        plain = ansi.sub(b"", bytes(out)).decode("utf-8", "replace")
        squashed = re.sub(r"\s+", "", plain)
        for needle, answer in [("trust this folder", b"\r"), ("Do you want to use this API key", b"1\r"), ("Press Enter to continue", b"\r"), ("Choose the text style", b"\r")]:
            if needle.replace(" ", "") in squashed and needle not in answered:
                time.sleep(0.8); os.write(master, answer); answered.add(needle)
        if done_at is None and re.search(r"(?m)^\W*DONE\W*$", plain.replace("●", "")):
            done_at = time.monotonic()
        if done_at is not None and time.monotonic() - done_at > 5: break
        if child.poll() is not None: break
finally:
    open(os.path.join(config, "terminal.txt"), "wb").write(bytes(out))
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try: child.wait(timeout=5)
        except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL)
print("DONE_SEEN" if done_at else "NO_DONE", sorted(answered))
