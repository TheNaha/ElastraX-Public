"""Non-deploying syntax and contract smoke checks for the experimental Modal adapter."""

from __future__ import annotations

import ast
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP_PATH = ROOT / "app.py"
PYPROJECT_PATH = ROOT / "pyproject.toml"
CONSTRAINTS_PATH = ROOT / "constraints.txt"
README_PATH = ROOT / "README.md"


class SmokeFailure(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def parse_source(path: Path) -> ast.Module:
    source = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(path))
        compile(source, str(path), "exec")
    except (OSError, SyntaxError, ValueError) as exc:
        raise SmokeFailure(f"{path.name} does not parse: {exc}") from exc
    return tree


def assigned_constants(tree: ast.Module) -> dict[str, object]:
    constants: dict[str, object] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try:
                constants[node.targets[0].id] = ast.literal_eval(node.value)
            except (ValueError, TypeError):
                continue
    return constants


def check_app_contract() -> None:
    tree = parse_source(APP_PATH)
    source = APP_PATH.read_text(encoding="utf-8")
    constants = assigned_constants(tree)
    model_name = constants.get("MODEL_NAME")
    revision = constants.get("MODEL_REVISION")
    image_ref = constants.get("VLLM_IMAGE_REF")
    require(model_name == "Qwen/Qwen3-8B", "the adapter must use the pinned text model")
    require(
        isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{40}", revision) is not None,
        "model revision is mutable",
    )
    require(
        isinstance(image_ref, str) and re.fullmatch(r"[^@]+@sha256:[0-9a-f]{64}", image_ref) is not None,
        "container image is not digest pinned",
    )
    require("MAX_REQUEST_BYTES = 256 * 1024" in source, "request limit is not fixed")
    require("MAX_RESPONSE_BYTES = 2 * 1024 * 1024" in source, "response limit is not fixed")
    require(constants.get("API_SECRET_NAME") == "elastra-api-secrets", "API secret is not mandatory")
    require("MODAL_PROXY_BEARER" in source and "VLLM_API_KEY" in source, "bearer secret lookup is missing")
    require("@modal.asgi_app(requires_proxy_auth=True)" in source, "Modal proxy auth is not required")
    require("@modal.web_server" not in source, "raw vLLM web server is exposed")
    require("@app.local_entrypoint" not in source, "deploy-time smoke entrypoint is present")
    require('"VLLM_SERVER_DEV_MODE": "0"' in source, "vLLM development mode is not disabled")
    require('"VLLM_MEDIA_URL_ALLOW_REDIRECTS": "0"' in source, "media redirects are not disabled")
    for forbidden in ("--omni", "--trust-remote-code", "--enable-sleep-mode", "--api" + "-key", "print("):
        require(forbidden not in source, f"unsafe or unsupported surface remains: {forbidden}")
    for required in (
        '"--host",\n        "127.0.0.1"',
        '"--language-model-only"',
        '"--enable-auto-tool-choice"',
        '"--tool-call-parser",\n        "hermes"',
        '"--reasoning-parser",\n        "qwen3"',
        '"--disable-log-requests"',
        '"transformers==4.57.6"',
        "MAX_REQUEST_BYTES",
        "MAX_RESPONSE_BYTES",
        "follow_redirects=False",
        "trust_env=False",
    ):
        require(required in source, f"required contract marker is missing: {required}")
    require("async def _proxy_chat" in source, "authenticated chat proxy is missing")
    require('Route("/v1/chat/completions"' in source, "chat completion route is missing")
    require('Route("/v1/models"' in source, "models route is missing")
    require(source.count("Route(") == 2, "unexpected public route is registered")
    require(
        "image_url" in source and "audio_url" in source and "video_url" in source,
        "media rejection is not explicit",
    )
    require("media content is not supported" in source, "media rejection error is missing")
    require("http://127.0.0.1" in source, "internal vLLM origin is not loopback")
    require("subprocess.Popen" in source and "start_new_session=True" in source, "process cleanup boundary is missing")
    require("_wait_for_readiness" in source and "READINESS_TIMEOUT_SEC" in source, "readiness timeout is missing")
    require("startup_timeout=STARTUP_TIMEOUT_SEC" in source, "startup timeout is missing")
    require("_stop_process" in source and "SHUTDOWN_TIMEOUT_SEC" in source, "shutdown timeout is missing")
    require("MODEL_REVISION[:12]" in source and "CACHE_VERSION" in source, "cache identity is not versioned")


def check_dependencies() -> None:
    try:
        project = tomllib.loads(PYPROJECT_PATH.read_text(encoding="utf-8"))
        constraints_text = CONSTRAINTS_PATH.read_text(encoding="utf-8")
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise SmokeFailure(f"dependency metadata is unreadable: {exc}") from exc
    dependencies = project.get("project", {}).get("dependencies", [])
    require(dependencies, "project dependencies are empty")
    require(all("==" in dependency for dependency in dependencies), "a project dependency is not pinned")
    constraint_lines = [
        line.strip() for line in constraints_text.splitlines() if line.strip() and not line.startswith("#")
    ]
    require(constraint_lines, "constraints file is empty")
    require(
        all(re.fullmatch(r"[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+", line) for line in constraint_lines),
        "constraint is not exact",
    )
    names = {line.split("==", 1)[0].lower().replace("_", "-") for line in constraint_lines}
    required_names = {"modal", "vllm", "fastapi", "starlette", "httpx", "transformers", "huggingface-hub"}
    require(required_names <= names, "required runtime pins are missing from constraints")


def check_readme() -> None:
    source = README_PATH.read_text(encoding="utf-8")
    for phrase in ("experimental", "Qwen/Qwen3-8B", "requires_proxy_auth", "ASR", "full-omni", "not supported"):
        require(phrase.lower() in source.lower(), f"README does not state {phrase}")


def main() -> int:
    try:
        check_app_contract()
        check_dependencies()
        check_readme()
    except (OSError, SmokeFailure) as exc:
        print(f"modal smoke: FAIL: {exc}", file=sys.stderr)
        return 1
    print("modal smoke: OK (syntax and contract checks only; no deployment)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
