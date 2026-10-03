"""Build the explicitly experimental wheel from its exact public source commit.

Requires uv; never publishes artifacts or substitutes an unverified wheel.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Clean Wandas git checkout at runtime/lock.json upstreamCommit")
    parser.add_argument("--uv", default="uv")
    options = parser.parse_args()
    lock = json.loads((ROOT / "runtime/lock.json").read_text())
    if lock.get("experimental") is not True:
        raise ValueError("Candidate builds require an explicitly experimental runtime lock")
    revision = subprocess.check_output(["git", "-C", str(options.source), "rev-parse", "HEAD"], text=True).strip()
    if revision != lock["upstreamCommit"]:
        raise ValueError("Source HEAD does not match the locked public Wandas commit")
    subprocess.run(["git", "-C", str(options.source), "diff", "--exit-code", "HEAD", "--"], check=True, stdout=subprocess.DEVNULL)
    asset = next(asset for asset in lock["assets"] if asset["component"] == "wandas")
    if asset["url"] != "local-build:" + asset["path"]:
        raise ValueError("The candidate wheel must be the locked local-build asset")
    with tempfile.TemporaryDirectory(prefix="insight-wandas-build-") as folder:
        stage = Path(folder)
        archive = subprocess.check_output(["git", "-C", str(options.source), "archive", revision, "wandas", "pyproject.toml", "README.md", "LICENSE", "LICENSE-THIRD-PARTY"])
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(stage, filter="data")
        project = stage / "pyproject.toml"
        text = project.read_text()
        original = 'version = "0.8.0"'
        if text.count(original) != 1:
            raise ValueError("Unexpected upstream version declaration")
        project.write_text(text.replace(original, f'version = "{lock["wandasVersion"]}"', 1))
        constraints = stage / "build-constraints.txt"
        constraints.write_text("hatchling==1.32.4\n")
        output = stage / "wheel"
        subprocess.run([options.uv, "build", "--wheel", "--build-constraint", str(constraints), "--out-dir", str(output), str(stage)], check=True)
        wheel = output / asset["path"]
        digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
        if digest != asset["sha256"] or wheel.stat().st_size != asset["bytes"]:
            raise ValueError("Candidate build differs from the locked wheel; update provenance deliberately")
        destination = ROOT / "runtime/prepared/runtime/audio" / asset["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(wheel, destination)
        print(json.dumps({"sourceCommit": revision, "wheel": wheel.name, "sha256": digest, "bytes": wheel.stat().st_size, "experimental": True}))


if __name__ == "__main__":
    main()
