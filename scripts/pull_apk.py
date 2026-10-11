#!/usr/bin/env python3
"""Copy the installed My MTS APKs from a selected, authorized Android device."""
import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

PACKAGE = "ru.mts.mymts"
ROOT = Path(__file__).resolve().parents[1]


def adb(*args):
    return subprocess.run(["adb", *args], check=True, text=True, capture_output=True).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", help="Select one device when several are connected")
    args = parser.parse_args()
    devices = [line.split()[0] for line in adb("devices").splitlines()[1:]
               if len(line.split()) >= 2 and line.split()[1] == "device"]
    if args.serial:
        if args.serial not in devices:
            raise RuntimeError("Selected device is absent or USB debugging is not authorized.")
        serial = args.serial
    elif len(devices) == 1:
        serial = devices[0]
    else:
        raise RuntimeError("Connect one Android device and authorize USB debugging, or use --serial.")
    paths = [line.removeprefix("package:").strip()
             for line in adb("-s", serial, "shell", "pm", "path", PACKAGE).splitlines()
             if line.startswith("package:")]
    if not paths:
        raise RuntimeError("My MTS (ru.mts.mymts) is not installed on the selected device.")
    out = ROOT / "artifacts" / ("mymts-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
    out.mkdir(parents=True, exist_ok=False)
    files = []
    for index, remote in enumerate(paths):
        name = f"{index:02d}-" + Path(remote).name
        local = out / name
        adb("-s", serial, "pull", remote, str(local))
        with local.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        files.append({"file": name, "sha256": digest, "bytes": local.stat().st_size})
    metadata = {"package": PACKAGE, "source": "installed application via adb pm path and adb pull", "files": files}
    (out / "provenance.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"directory": str(out), **metadata}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, FileNotFoundError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from None
