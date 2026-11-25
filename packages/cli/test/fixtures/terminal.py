# Runs a command in a pseudo-terminal, as a person at a terminal would, and types `answer` once the
# command asks to confirm: a line ending in Enter, or "EOF" for Ctrl+D. Prints everything the
# terminal showed and exits with the command's exit code.
#   python3 terminal.py <answer> <command> [args...]
import os
import pty
import select
import sys

answer = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])

shown = b''
typed = False
while True:
    ready, _, _ = select.select([fd], [], [], 60)
    if not ready:
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    shown += chunk
    if not typed and '输入 yes 确认'.encode() in shown:
        os.write(fd, b'\x04' if answer == 'EOF' else answer.encode() + b'\r')
        typed = True

_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(shown)
sys.exit(os.waitstatus_to_exitcode(status))
