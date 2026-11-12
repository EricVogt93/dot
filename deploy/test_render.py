"""Tests for deploy/render.py.

Uses real `kubectl kustomize` against the example overlay (no cluster or
kubeconfig needed) plus temporary overlays for the failure variants.
Requires PyYAML and kubectl on PATH.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
RENDER = HERE / "render.py"
EXAMPLE_OVERLAY = HERE / "overlays" / "example"
OVERLAYS_DIR = HERE / "overlays"
TEST_DIGEST = "registry.example.com/team/dot@sha256:" + "ab" * 32


def run_render(overlay, image_ref):
    return subprocess.run(
        [sys.executable, str(RENDER), str(overlay), image_ref],
        capture_output=True,
        text=True,
        check=False,
    )


def kustomize(overlay):
    proc = subprocess.run(
        ["kubectl", "kustomize", str(overlay)],
        capture_output=True,
        text=True,
        check=True,
    )
    return [doc for doc in yaml.safe_load_all(proc.stdout) if doc is not None]


def deployment_of(docs):
    return next(
        doc
        for doc in docs
        if doc.get("apiVersion") == "apps/v1"
        and doc.get("kind") == "Deployment"
        and doc["metadata"]["name"] == "dot"
    )


@unittest.skipUnless(shutil.which("kubectl"), "kubectl is required")
class RenderTests(unittest.TestCase):
    def test_example_overlay_pins_only_the_target_container(self):
        original = kustomize(EXAMPLE_OVERLAY)
        proc = run_render(EXAMPLE_OVERLAY, TEST_DIGEST)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rendered = [doc for doc in yaml.safe_load_all(proc.stdout) if doc is not None]

        # Same document set, same order.
        self.assertEqual(len(rendered), len(original))
        orig_dep = deployment_of(original)
        new_dep = deployment_of(rendered)
        containers = new_dep["spec"]["template"]["spec"]["containers"]
        self.assertEqual(len(containers), 1)
        self.assertEqual(containers[0]["image"], TEST_DIGEST)

        # Every other resource is semantically identical to plain kustomize.
        for before, after in zip(original, rendered):
            if before is orig_dep:
                expected = yaml.safe_load(yaml.safe_dump(before))
                expected["spec"]["template"]["spec"]["containers"][0]["image"] = TEST_DIGEST
                self.assertEqual(after, expected)
            else:
                self.assertEqual(after, before)

    def test_sidecar_containers_are_untouched(self):
        with tempfile.TemporaryDirectory(dir=OVERLAYS_DIR) as tmp:
            overlay = Path(tmp)
            base_rel = os.path.relpath(HERE / "base", overlay)
            (overlay / "kustomization.yaml").write_text(
                "apiVersion: kustomize.config.k8s.io/v1beta1\n"
                "kind: Kustomization\n"
                "resources:\n"
                f"  - {base_rel}\n"
                "patches:\n"
                "  - target:\n"
                "      kind: Deployment\n"
                "      name: dot\n"
                "    patch: |-\n"
                "      - op: add\n"
                "        path: /spec/template/spec/containers/-\n"
                "        value:\n"
                "          name: sidecar\n"
                "          image: sidecar:1.0\n"
            )
            proc = run_render(overlay, TEST_DIGEST)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            docs = [d for d in yaml.safe_load_all(proc.stdout) if d is not None]
            containers = deployment_of(docs)["spec"]["template"]["spec"]["containers"]
            by_name = {c["name"]: c for c in containers}
            self.assertEqual(by_name["dot"]["image"], TEST_DIGEST)
            self.assertEqual(by_name["sidecar"]["image"], "sidecar:1.0")

    def test_missing_deployment_fails_without_stdout(self):
        with tempfile.TemporaryDirectory(dir=OVERLAYS_DIR) as tmp:
            overlay = Path(tmp)
            base_rel = os.path.relpath(HERE / "base", overlay)
            (overlay / "kustomization.yaml").write_text(
                "apiVersion: kustomize.config.k8s.io/v1beta1\n"
                "kind: Kustomization\n"
                "resources: []\n"
            )
            proc = run_render(overlay, TEST_DIGEST)
            self.assertNotEqual(proc.returncode, 0)
            self.assertEqual(proc.stdout, "")
            self.assertIn("Deployment", proc.stderr)

    def test_ambiguous_container_fails_without_stdout(self):
        with tempfile.TemporaryDirectory(dir=OVERLAYS_DIR) as tmp:
            overlay = Path(tmp)
            base_rel = os.path.relpath(HERE / "base", overlay)
            (overlay / "kustomization.yaml").write_text(
                "apiVersion: kustomize.config.k8s.io/v1beta1\n"
                "kind: Kustomization\n"
                "resources:\n"
                f"  - {base_rel}\n"
                "patches:\n"
                "  - target:\n"
                "      kind: Deployment\n"
                "      name: dot\n"
                "    patch: |-\n"
                "      - op: add\n"
                "        path: /spec/template/spec/containers/-\n"
                "        value:\n"
                "          name: dot\n"
                "          image: duplicate:1.0\n"
            )
            proc = run_render(overlay, TEST_DIGEST)
            self.assertNotEqual(proc.returncode, 0)
            self.assertEqual(proc.stdout, "")
            self.assertIn("container", proc.stderr)

    def test_invalid_image_refs_fail_without_stdout(self):
        for bad in [
            "registry.example.com/dot:latest",
            "registry.example.com/dot@sha256:short",
            "registry.example.com/dot@md5:" + "ab" * 32,
            "",
        ]:
            proc = run_render(EXAMPLE_OVERLAY, bad)
            self.assertNotEqual(proc.returncode, 0, bad)
            self.assertEqual(proc.stdout, "", bad)

    def test_kustomize_failure_fails_without_stdout(self):
        with tempfile.TemporaryDirectory(dir=OVERLAYS_DIR) as tmp:
            overlay = Path(tmp)
            base_rel = os.path.relpath(HERE / "base", overlay)
            (overlay / "kustomization.yaml").write_text(
                "apiVersion: kustomize.config.k8s.io/v1beta1\n"
                "kind: Kustomization\n"
                "resources:\n"
                "  - does-not-exist.yaml\n"
            )
            proc = run_render(overlay, TEST_DIGEST)
            self.assertNotEqual(proc.returncode, 0)
            self.assertEqual(proc.stdout, "")

    def test_wrong_argument_count_fails(self):
        proc = subprocess.run(
            [sys.executable, str(RENDER)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")


if __name__ == "__main__":
    unittest.main()