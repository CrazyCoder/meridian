#!/usr/bin/env python3
"""Drive the actual TUI in a PTY, or print mode for its omitted-display control."""
import json
import fcntl
import os
import pty
import select
import signal
import subprocess
import struct
import sys
import termios
import time
import urllib.request
import pyte

client, project, config, url, receipt, mode, expected_failure, client_mode = sys.argv[1:]
environment = dict(os.environ)
for key in list(environment):
    if key.startswith(("MERIDIAN_", "CLAUDE_", "ANTHROPIC_", "CLAUDE_PROXY_")) or key == "CLAUDECODE":
        del environment[key]
environment.update(ANTHROPIC_API_KEY="verification-loopback", ANTHROPIC_BASE_URL=url,
                   CLAUDE_CONFIG_DIR=config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
                   CLAUDE_CODE_THINKING_DISPLAY_UPDATES="true", TERM="dumb")
arguments = [client, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
             "--model", os.environ.get("E2E_MODEL", "claude-sonnet-5"), "--tools", "Read", "--allowedTools", "Read"]
if client_mode == "interactive":
    arguments += ["--ax-screen-reader"]
else:
    arguments += ["--print", f"Reply with exactly {receipt}. Do not use tools."]
arguments += ["--thinking", "disabled" if mode == "disabled" else "adaptive"]
if mode not in ("updates", "disabled"):
    arguments += ["--thinking-display", mode]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
child = subprocess.Popen(arguments, cwd=project, env=environment, stdin=slave, stdout=slave,
                         stderr=slave, start_new_session=True)
os.close(slave)
output = bytearray()
screen = pyte.Screen(100, 24)
terminal_stream = pyte.ByteStream(screen)
answered = set()
retry_count = 0
prompt_sent = False
success = False
result = None
try:
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
            terminal_stream.feed(chunk)
            with open(os.path.join(config, "terminal.txt"), "wb") as stream:
                stream.write(output)
            os.chmod(os.path.join(config, "terminal.txt"), 0o600)
            if len(output) > 2 * 1024 * 1024:
                raise RuntimeError("PTY output exceeded the fixture bound")
        text = output.decode("utf-8", "replace")
        # Every answer concerns this harness's empty directory and dummy local
        # API key. Never answer a credential or account-login prompt.
        for prompt, answer in [("Select with numbers", b"2\r"), ("Do you want to use this API key?", b"y\r"),
                               ("Press Enter to continue", b"\r"), ("Yes, I trust this folder", b"y\r")]:
            if prompt in text and prompt not in answered:
                # Wait for the newly rendered screen-reader prompt's input
                # listener to mount before typing its answer.
                time.sleep(0.5)
                if len(answer) > 1:
                    os.write(master, answer[:-1])
                    # The screen-reader prompt commits typed state on a render;
                    # a character and Enter in one PTY read can submit old state.
                    time.sleep(0.2)
                os.write(master, answer[-1:])
                answered.add(prompt)
        rejections = text.count("Please answer y or n.")
        if client_mode == "interactive" and rejections > retry_count:
            if not answered.intersection({"Do you want to use this API key?", "Yes, I trust this folder"}):
                raise RuntimeError("unexpected yes/no prompt outside isolated onboarding")
            if rejections > 4:
                raise RuntimeError("isolated onboarding prompt rejected repeated PTY answers")
            time.sleep(0.5)
            os.write(master, b"y")
            time.sleep(0.2)
            os.write(master, b"\r")
            retry_count = rejections
        with urllib.request.urlopen(url + "/__thinking_display_proof", timeout=2) as response:
            facts = json.load(response)
        # Ink often emits only the changed suffix with cursor motion; stripping
        # ANSI sequences cannot prove the final answer rendered completely.
        plain = "\n".join(screen.display)
        visible_lines = [line.rstrip() for line in screen.display if line.strip()]
        if client_mode == "interactive" and not prompt_sent and "effort:" in plain and visible_lines and visible_lines[-1].strip() == "$":
            # Match the reported human-in-TUI flow, rather than supplying an
            # initial positional prompt on the client's command line.
            time.sleep(0.5)
            os.write(master, f"Reply with exactly {receipt}. Do not use tools.".encode())
            time.sleep(0.2)
            os.write(master, b"\r")
            prompt_sent = True
        rendered = "claude: " + receipt in plain if client_mode == "interactive" else receipt in text
        rejected = any(fact.get("unsupportedDisplay") for fact in facts)
        if expected_failure == "1" and rejected:
            success = True
            result = {"actualInteractive": True, "promptSentInTui": prompt_sent, "nativeDisplayRejection": True, "receiptDelivered": rendered}
            break
        completed_turn = any(fact.get("status") == 200 and fact.get("receipt") and not fact.get("errorEvent")
                             and (fact.get("thinking", {}).get("type") == "disabled" if mode == "disabled"
                                  else fact.get("thinking", {}).get("display") == mode) for fact in facts)
        if expected_failure != "1" and rendered and completed_turn:
            success = True
            result = {"actualInteractive": client_mode == "interactive", "promptSentInTui": prompt_sent, "nativeDisplayRejection": rejected, "receiptDelivered": True}
            break
        if child.poll() is not None:
            break
    if not success:
        raise RuntimeError("actual interactive client did not reach the required verdict")
finally:
    transcript = os.path.join(config, "terminal.txt")
    with open(transcript, "wb") as stream:
        stream.write(output)
    os.chmod(transcript, 0o600)
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
    os.close(master)
print(json.dumps(result))
