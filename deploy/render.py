#!/usr/bin/env python3
"""Render a kustomize overlay with exactly one digest-pinned image.

Usage: render.py OVERLAY IMAGE_REF

Runs `kubectl kustomize OVERLAY`, requires exactly one apps/v1 Deployment
named "dot" with exactly one container named "dot", replaces only that
container's image with the validated digest reference, and writes all
documents as YAML to stdout. Everything else (other containers, PVCs,
namespace, node placement, imagePullSecrets, ...) is preserved verbatim.

Any invalid argument, missing/ambiguous target, invalid YAML or kustomize
failure exits non-zero with no deployable stdout output.
"""

import re
import subprocess
import sys

import yaml

# repository@sha256:<64 hex>
DIGEST_REF = re.compile(
    r"^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*"
    r"(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*"
    r"(?::[0-9]+)?"
    r"@[a-z0-9]+:[0-9a-f]{64}$"
)


def fail(message: str) -> None:
    print(f"render.py: {message}", file=sys.stderr)
    sys.exit(1)


def valid_image_ref(ref: str) -> bool:
    if not DIGEST_REF.match(ref):
        return False
    algo, _, digest = ref.rpartition("@")[2].partition(":")
    return algo == "sha256" and len(digest) == 64


def render(overlay: str, image_ref: str) -> str:
    if not valid_image_ref(image_ref):
        fail(f"image reference must be repository@sha256:<64 hex>, got: {image_ref!r}")

    try:
        proc = subprocess.run(
            ["kubectl", "kustomize", overlay],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        fail("kubectl is not installed or not on PATH")
    if proc.returncode != 0:
        fail(f"kubectl kustomize failed:\n{proc.stderr.strip()}")

    try:
        docs = [doc for doc in yaml.safe_load_all(proc.stdout) if doc is not None]
    except yaml.YAMLError as error:
        fail(f"kustomize output is not valid YAML: {error}")

    targets = []
    for doc in docs:
        if not isinstance(doc, dict):
            fail("kustomize output contains a non-mapping document")
        if doc.get("apiVersion") == "apps/v1" and doc.get("kind") == "Deployment":
            if (doc.get("metadata") or {}).get("name") == "dot":
                targets.append(doc)
    if len(targets) != 1:
        fail(f"expected exactly one apps/v1 Deployment named 'dot', found {len(targets)}")

    containers = (
        targets[0].get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [])
    )
    matches = [c for c in containers if isinstance(c, dict) and c.get("name") == "dot"]
    if len(matches) != 1:
        fail(f"expected exactly one container named 'dot' in the deployment, found {len(matches)}")

    # Only the target container's image changes; nothing else is touched.
    matches[0]["image"] = image_ref

    return yaml.safe_dump_all(docs, sort_keys=False)


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: render.py OVERLAY IMAGE_REF")
    # Validate fully before emitting anything to stdout.
    output = render(sys.argv[1], sys.argv[2])
    sys.stdout.write(output)


if __name__ == "__main__":
    main()