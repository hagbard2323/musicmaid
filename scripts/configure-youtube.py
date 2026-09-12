#!/usr/bin/env python3
"""Install only an explicitly authorized, private YouTube session for MusicMaid."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import stat
import tempfile
import time


def youtube_cookies(source):
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 65536:
        raise ValueError("Use a private, regular cookie file (mode 0600, at most 64 KiB).")
    lines = ["# Netscape HTTP Cookie File", "# Dedicated MusicMaid YouTube account session"]
    names = set()
    for line in source.read_text().splitlines():
        if not line.strip() or (line.startswith("#") and not line.startswith("#HttpOnly_")):
            continue
        fields = line.split("\t")
        if len(fields) != 7:
            raise ValueError("Invalid Netscape cookie file; contents were not printed.")
        domain = fields[0].removeprefix("#HttpOnly_").lstrip(".").lower()
        if domain != "youtube.com" and not domain.endswith(".youtube.com"):
            continue
        if not fields[4].isdigit() or any("\0" in value for value in fields):
            raise ValueError("Invalid YouTube session data; contents were not printed.")
        if int(fields[4]) and int(fields[4]) <= time.time():
            continue
        lines.append(line)
        names.add(fields[5])
    if not names.intersection({"SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"}):
        raise ValueError("No current YouTube login found. Refresh the dedicated account session.")
    return "\n".join(lines) + "\n"


def update_environment(text, values):
    pattern = r"^[ \t]*(?:export[ \t]+)?(?:YOUTUBE_COOKIE_FILE|YTDLP_BINARY)[ \t]*="
    lines = [line for line in text.splitlines() if not re.match(pattern, line)]
    return "\n".join(lines + [key + "=" + json.dumps(value) for key, value in values.items()]) + "\n"


def atomic_private(path, text, owner):
    fd, temporary = tempfile.mkstemp(prefix=".youtube-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), owner.pw_uid, owner.pw_gid)
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    content = youtube_cookies(args.source)
    if args.check_only:
        print("Private YouTube session format checked; no credentials printed or installed.")
        return
    if os.geteuid() != 0:
        raise SystemExit("Run through the reviewed deployment installer with sudo.")
    owner = pwd.getpwnam("botsvc")
    target = Path("/var/lib/audiobot/youtube-cookies.txt")
    environment = Path("/opt/botsvc/audiobot/.env")
    updated = update_environment(environment.read_text(), {
        "YOUTUBE_COOKIE_FILE": str(target),
        "YTDLP_BINARY": "/opt/botsvc/audiobot-tools/venv/bin/yt-dlp",
    })
    atomic_private(target, content, owner)
    atomic_private(environment, updated, owner)
    print("Dedicated YouTube session installed privately for MusicMaid.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(str(error))
