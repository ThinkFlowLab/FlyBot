"""Build a manager release from a verified, fixed dependency image."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess


APP_TREES = ("flybot_workspace", "manager")
APP_FILES = ("wsgi.py", "manager-poll.py")
RUNTIME_CONFIG = (
    "Env", "WorkingDir", "User", "Entrypoint", "Cmd", "Healthcheck",
    "StopSignal", "Volumes", "ExposedPorts", "Shell", "OnBuild",
)
REVISION_LABEL = "org.opencontainers.image.revision"
IMAGE_MANIFEST = """
from hashlib import sha256
import json
from pathlib import Path
app = Path('/app')
paths = [path for name in ('flybot_workspace', 'manager') for path in (app/name).rglob('*') if path.is_file()]
paths.extend(app/name for name in ('wsgi.py', 'manager-poll.py'))
print(json.dumps({path.relative_to(app).as_posix(): sha256(path.read_bytes()).hexdigest() for path in paths}))
"""


def inspect(image):
    return json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]


def revision(image):
    return (image["Config"].get("Labels") or {}).get(REVISION_LABEL)


def staged_manifest(context):
    source = context / "release"
    files = {
        path.relative_to(source).as_posix(): sha256(path.read_bytes()).hexdigest()
        for name in APP_TREES
        for path in (source / name).rglob("*")
        if path.is_file()
    }
    if any(not any(path.startswith(name + "/") for path in files) for name in APP_TREES):
        raise ValueError("The staged application and manager trees must both contain files.")
    files.update({name: sha256((context / name).read_bytes()).hexdigest() for name in APP_FILES})
    return files


def build(args):
    expected_files = staged_manifest(args.context)
    base = inspect(args.base)
    if base["Id"] != args.base_id:
        raise ValueError("The manager dependency image does not match its pinned ID.")
    if revision(inspect(args.web)) != args.revision:
        raise ValueError("The web image does not match the requested release.")
    dockerfile = Path(__file__).with_name("Dockerfile.manager-release")
    subprocess.run(
        ["docker", "build", "--file", str(dockerfile),
         "--build-arg", f"WEB_IMAGE={args.web}", "--build-arg", f"MANAGER_BASE={args.base}",
         "--label", f"{REVISION_LABEL}={args.revision}", "--tag", args.tag, str(args.context)],
        check=True,
    )
    image = inspect(args.tag)
    layers = base["RootFS"]["Layers"]
    if revision(image) != args.revision or image["RootFS"]["Layers"][:len(layers)] != layers:
        raise ValueError("The built manager has the wrong revision or dependency base.")
    different = [key for key in RUNTIME_CONFIG if base["Config"].get(key) != image["Config"].get(key)]
    if different:
        raise ValueError("Manager runtime configuration changed: " + ", ".join(different))
    built_files = json.loads(subprocess.check_output(
        ["docker", "run", "--rm", "--network", "none", "--entrypoint", "python", args.tag, "-c", IMAGE_MANIFEST]
    ))
    if built_files != expected_files:
        different = sorted(name for name in built_files.keys() | expected_files.keys()
                           if built_files.get(name) != expected_files.get(name))
        raise ValueError("Manager application differs from the staged release: " + ", ".join(different[:10]))
    print(json.dumps({
        "revision": args.revision,
        "base_id": args.base_id,
        "base_layers": len(layers),
        "release_layers": len(image["RootFS"]["Layers"]),
        "files_verified": len(expected_files),
    }))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="Locally loaded manager dependency image tag")
    parser.add_argument("--base-id", required=True, help="Pinned image ID for the manager dependency base")
    parser.add_argument("--web", required=True, help="Web image built for this release")
    parser.add_argument("--revision", required=True, help="Git commit SHA of the release")
    parser.add_argument("--tag", required=True, help="Tag for the built manager image")
    parser.add_argument("--context", required=True, type=Path, help="Staged web and manager build context")
    args = parser.parse_args()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", args.base_id) or not re.fullmatch(r"[a-f0-9]{40}", args.revision):
        parser.error("Supply a full image ID and Git revision.")
    build(args)


if __name__ == "__main__":
    main()
