"""Experimental, text-and-tool-only OpenAI-compatible vLLM adapter for Modal."""

from __future__ import annotations

import asyncio
import hmac
import importlib.metadata
import json
import os
import re
import secrets
import signal
import subprocess
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
import modal
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

MINUTES = 60
APP_NAME = "elastra-x-vllm-experimental"
MODEL_NAME = "Qwen/Qwen3-8B"
MODEL_REVISION = "b968826d9c46dd6066d109eabc6255188de91218"
VLLM_VERSION = "0.16.0"
VLLM_IMAGE_REF = "vllm/vllm-openai@sha256:4801151759655c57606c844662e5213403c032a62d149c7ce61d615759a821ef"
CACHE_VERSION = "qwen3-8b-text-v1"
MODEL_CACHE_KEY = "qwen3-8b-text"
HF_CACHE_VOLUME_NAME = f"elastra-modal-{MODEL_CACHE_KEY}-{MODEL_REVISION[:12]}-{CACHE_VERSION}-hf"
VLLM_CACHE_VOLUME_NAME = f"elastra-modal-{MODEL_CACHE_KEY}-{MODEL_REVISION[:12]}-{CACHE_VERSION}-vllm"
HF_CACHE_PATH = "/root/.cache/huggingface"
VLLM_CACHE_PATH = "/root/.cache/vllm"

VLLM_PORT = 8000
LOCAL_ORIGIN = f"http://127.0.0.1:{VLLM_PORT}"
MAX_MODEL_LEN = 32768
MAX_OUTPUT_TOKENS = 8192
MAX_NUM_SEQS = 8
MAX_NUM_BATCHED_TOKENS = 8192
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
REQUEST_READ_TIMEOUT_SEC = 15
MAX_MESSAGES = 64
MAX_MESSAGE_CHARS = 32000
MAX_TOOLS = 64
MAX_TOOL_DESCRIPTION_CHARS = 4096
MAX_TOOL_SCHEMA_DEPTH = 8
MAX_TOOL_SCHEMA_NODES = 256
MAX_METADATA_ENTRIES = 16
MAX_METADATA_VALUE_CHARS = 256
MAX_USER_CHARS = 128
MAX_STOP_ITEMS = 4
MAX_STOP_CHARS = 256
STARTUP_TIMEOUT_SEC = 10 * MINUTES
READINESS_TIMEOUT_SEC = 8 * MINUTES
SHUTDOWN_TIMEOUT_SEC = 30
UPSTREAM_CONNECT_TIMEOUT_SEC = 5
UPSTREAM_READ_TIMEOUT_SEC = 120
UPSTREAM_WRITE_TIMEOUT_SEC = 10
MAX_CONCURRENT_INPUTS = 8

API_SECRET_NAME = "elastra-api-secrets"
HF_SECRET_NAME = "my-huggingface-secret"
AUTH_ENV_NAMES = ("MODAL_PROXY_BEARER", "VLLM_API_KEY", "MODAL_API_KEY")
API_KEY_MIN_LENGTH = 32

ALLOWED_TOP_LEVEL_FIELDS = {
    "model",
    "messages",
    "tools",
    "tool_choice",
    "temperature",
    "max_tokens",
    "max_completion_tokens",
    "top_p",
    "stop",
    "stream",
    "seed",
    "presence_penalty",
    "frequency_penalty",
    "n",
    "response_format",
    "parallel_tool_calls",
    "stream_options",
    "user",
    "metadata",
    "reasoning_effort",
    "chat_template_kwargs",
}
ALLOWED_ROLES = {"system", "developer", "user", "assistant", "tool"}
MEDIA_KEYS = {
    "audio",
    "audio_url",
    "file",
    "file_id",
    "image",
    "image_url",
    "input_audio",
    "media",
    "media_url",
    "source_url",
    "video",
    "video_url",
}
ALLOWED_RESPONSE_FORMATS = {"text", "json_object"}
ALLOWED_REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high"}
SHA_REVISION = re.compile(r"^[0-9a-f]{40}$")
IMAGE_DIGEST = re.compile(r"^[^@]+@sha256:[0-9a-f]{64}$")


class RequestContractError(ValueError):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class ResponseContractError(RuntimeError):
    pass


def _validate_static_contract() -> None:
    if not SHA_REVISION.fullmatch(MODEL_REVISION):
        raise RuntimeError("MODEL_REVISION must be an immutable Hugging Face commit")
    if not IMAGE_DIGEST.fullmatch(VLLM_IMAGE_REF):
        raise RuntimeError("VLLM_IMAGE_REF must use an immutable registry digest")
    if not CACHE_VERSION or not MODEL_CACHE_KEY:
        raise RuntimeError("cache identity must be versioned")
    if MAX_REQUEST_BYTES <= 0 or MAX_RESPONSE_BYTES <= 0:
        raise RuntimeError("request and response limits must be positive")
    if MAX_OUTPUT_TOKENS <= 0 or MAX_MODEL_LEN < MAX_OUTPUT_TOKENS:
        raise RuntimeError("invalid model token limits")
    if len(HF_CACHE_VOLUME_NAME) > 63 or len(VLLM_CACHE_VOLUME_NAME) > 63:
        raise RuntimeError("Modal volume names must be at most 63 characters")


def _expected_bearer() -> str:
    values = {value.strip() for name in AUTH_ENV_NAMES if (value := os.environ.get(name, "").strip())}
    if not values:
        raise RuntimeError("Modal proxy authentication is not configured")
    if len(values) != 1:
        raise RuntimeError("multiple conflicting Modal authentication secrets are configured")
    value = next(iter(values))
    if len(value) < API_KEY_MIN_LENGTH:
        raise RuntimeError("Modal proxy authentication secret is too short")
    return value


def _presented_bearer(request: Request) -> str | None:
    authorization = request.headers.get("authorization", "")
    prefix = "Bearer "
    if authorization:
        if not authorization.startswith(prefix):
            return None
        return authorization[len(prefix) :].strip() or None
    modal_key = request.headers.get("modal-key", "").strip()
    modal_secret = request.headers.get("modal-secret", "").strip()
    if modal_key and modal_secret:
        if len(modal_key) > 256 or len(modal_secret) > 256:
            return None
        return f"{modal_key}.{modal_secret}"
    return None


def _check_bearer(request: Request, request_id: str) -> JSONResponse | None:
    try:
        expected = _expected_bearer()
    except RuntimeError:
        return _json_error(503, "authentication is not configured", "service_unavailable", request_id)
    received = _presented_bearer(request)
    if received is None or len(received) > 512:
        return _json_error(401, "missing bearer credentials", "unauthorized", request_id)
    if not hmac.compare_digest(received.encode("utf-8"), expected.encode("utf-8")):
        return _json_error(401, "invalid bearer credentials", "unauthorized", request_id)
    return None


def _json_error(status_code: int, message: str, error_type: str, request_id: str) -> JSONResponse:
    return JSONResponse(
        {"error": {"message": message, "type": error_type, "request_id": request_id}},
        status_code=status_code,
        headers=_response_headers(request_id),
    )


def _response_headers(request_id: str) -> dict[str, str]:
    return {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": request_id,
    }


def _build_vllm_command() -> list[str]:
    return [
        "vllm",
        "serve",
        MODEL_NAME,
        "--revision",
        MODEL_REVISION,
        "--served-model-name",
        MODEL_NAME,
        "--host",
        "127.0.0.1",
        "--port",
        str(VLLM_PORT),
        "--max-model-len",
        str(MAX_MODEL_LEN),
        "--max-num-seqs",
        str(MAX_NUM_SEQS),
        "--max-num-batched-tokens",
        str(MAX_NUM_BATCHED_TOKENS),
        "--gpu-memory-utilization",
        "0.90",
        "--seed",
        "0",
        "--language-model-only",
        "--chat-template-content-format",
        "string",
        "--default-chat-template-kwargs",
        json.dumps({"enable_thinking": False}, separators=(",", ":")),
        "--enable-auto-tool-choice",
        "--tool-call-parser",
        "hermes",
        "--reasoning-parser",
        "qwen3",
        "--max-logprobs",
        "1",
        "--disable-log-requests",
        "--disable-uvicorn-access-log",
        "--disable-log-stats",
        "--disable-fastapi-docs",
        "--no-enable-log-outputs",
        "--tensor-parallel-size",
        "1",
    ]


def _child_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name in tuple(environment):
        if name in AUTH_ENV_NAMES or name.endswith("_API_KEY"):
            environment.pop(name, None)
    environment["VLLM_SERVER_DEV_MODE"] = "0"
    environment["VLLM_MEDIA_URL_ALLOW_REDIRECTS"] = "0"
    environment["HF_HUB_DISABLE_TELEMETRY"] = "1"
    environment["TOKENIZERS_PARALLELISM"] = "false"
    return environment


def _assert_vllm_version() -> None:
    try:
        actual = importlib.metadata.version("vllm")
    except importlib.metadata.PackageNotFoundError:
        return
    if actual != VLLM_VERSION:
        raise RuntimeError("the runtime vLLM version does not match the pinned image")


def _assert_process_running(process: subprocess.Popen[bytes]) -> None:
    return_code = process.poll()
    if return_code is not None:
        raise RuntimeError("vLLM process exited before readiness")


def _wait_for_readiness(process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + READINESS_TIMEOUT_SEC
    timeout = httpx.Timeout(3.0, connect=2.0)
    with httpx.Client(timeout=timeout, trust_env=False, follow_redirects=False) as client:
        while time.monotonic() < deadline:
            _assert_process_running(process)
            try:
                health = client.get(f"{LOCAL_ORIGIN}/health")
                models = client.get(f"{LOCAL_ORIGIN}/v1/models")
                if health.status_code == 200 and models.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(2)
    raise TimeoutError("vLLM readiness deadline exceeded")


def _stop_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            process.terminate()
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=SHUTDOWN_TIMEOUT_SEC)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            process.kill()
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON member")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _check_json_shape(value: Any, depth: int = 0, counter: list[int] | None = None) -> None:
    if counter is None:
        counter = [0]
    counter[0] += 1
    if counter[0] > 20000 or depth > 12:
        raise RequestContractError(400, "JSON structure is too complex")
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                raise RequestContractError(400, "JSON object keys must be strings")
            if key.lower() in MEDIA_KEYS:
                raise RequestContractError(400, "media content is not supported")
            _check_json_shape(child, depth + 1, counter)
    elif isinstance(value, list):
        for child in value:
            _check_json_shape(child, depth + 1, counter)
    elif isinstance(value, str) and len(value) > MAX_MESSAGE_CHARS * 2:
        raise RequestContractError(400, "JSON string is too long")


async def _read_limited_body(request: Request) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_length = int(content_length)
        except ValueError as exc:
            raise RequestContractError(400, "invalid content length") from exc
        if declared_length < 0:
            raise RequestContractError(400, "invalid content length")
        if declared_length > MAX_REQUEST_BYTES:
            raise RequestContractError(413, "request body is too large")
    if request.headers.get("content-encoding", "identity").lower() != "identity":
        raise RequestContractError(415, "compressed request bodies are not supported")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_REQUEST_BYTES:
            raise RequestContractError(413, "request body is too large")
    if not body:
        raise RequestContractError(400, "request body is required")
    return bytes(body)


def _decode_payload(body: bytes) -> dict[str, Any]:
    try:
        value = json.loads(
            body.decode("utf-8"),
            object_pairs_hook=_object_without_duplicates,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise RequestContractError(400, "request body must be valid JSON") from exc
    if not isinstance(value, dict):
        raise RequestContractError(400, "request body must be a JSON object")
    _check_json_shape(value)
    return value


def _bounded_string(value: Any, field: str, maximum: int) -> str:
    if not isinstance(value, str) or len(value) > maximum:
        raise RequestContractError(400, f"{field} is invalid or too long")
    return value


def _bounded_int(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise RequestContractError(400, f"{field} is outside the allowed range")
    return value


def _bounded_number(value: Any, field: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RequestContractError(400, f"{field} must be a number")
    if not minimum <= float(value) <= maximum:
        raise RequestContractError(400, f"{field} is outside the allowed range")
    return float(value)


def _validate_tool_schema(schema: Any, depth: int = 0, counter: list[int] | None = None) -> None:
    if counter is None:
        counter = [0]
    counter[0] += 1
    if depth > MAX_TOOL_SCHEMA_DEPTH or counter[0] > MAX_TOOL_SCHEMA_NODES:
        raise RequestContractError(400, "tool schema is too complex")
    if isinstance(schema, dict):
        for key, value in schema.items():
            if not isinstance(key, str):
                raise RequestContractError(400, "tool schema keys must be strings")
            if key.lower() in MEDIA_KEYS:
                raise RequestContractError(400, "media tool fields are not supported")
            if isinstance(value, str) and len(value) > MAX_TOOL_DESCRIPTION_CHARS:
                raise RequestContractError(400, "tool schema string is too long")
            _validate_tool_schema(value, depth + 1, counter)
    elif isinstance(schema, list):
        for value in schema:
            _validate_tool_schema(value, depth + 1, counter)
    elif isinstance(schema, (str, int, float, bool)) or schema is None:
        return
    else:
        raise RequestContractError(400, "tool schema contains an unsupported value")


def _validate_tools(raw_tools: Any) -> tuple[list[dict[str, Any]], set[str]]:
    if not isinstance(raw_tools, list):
        raise RequestContractError(400, "tools must be an array")
    if len(raw_tools) > MAX_TOOLS:
        raise RequestContractError(400, "too many tools")
    tools: list[dict[str, Any]] = []
    names: set[str] = set()
    for raw_tool in raw_tools:
        if not isinstance(raw_tool, dict) or raw_tool.get("type") != "function":
            raise RequestContractError(400, "only function tools are supported")
        function = raw_tool.get("function")
        if not isinstance(function, dict):
            raise RequestContractError(400, "tool function is invalid")
        name = function.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", name):
            raise RequestContractError(400, "tool name is invalid")
        if name in names:
            raise RequestContractError(400, "tool names must be unique")
        names.add(name)
        normalized_function: dict[str, Any] = {"name": name, "parameters": function.get("parameters")}
        if "description" in function:
            normalized_function["description"] = _bounded_string(
                function["description"], "tool description", MAX_TOOL_DESCRIPTION_CHARS
            )
        if "strict" in function:
            if not isinstance(function["strict"], bool):
                raise RequestContractError(400, "tool strict must be boolean")
            normalized_function["strict"] = function["strict"]
        if not isinstance(normalized_function["parameters"], dict):
            raise RequestContractError(400, "tool parameters must be an object")
        _validate_tool_schema(normalized_function["parameters"])
        tools.append({"type": "function", "function": normalized_function})
    return tools, names


def _validate_tool_calls(raw_calls: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_calls, list) or len(raw_calls) > 8:
        raise RequestContractError(400, "tool_calls must be a bounded array")
    calls: list[dict[str, Any]] = []
    for raw_call in raw_calls:
        if not isinstance(raw_call, dict) or raw_call.get("type") != "function":
            raise RequestContractError(400, "only function tool calls are supported")
        call_id = _bounded_string(raw_call.get("id"), "tool call id", 128)
        function = raw_call.get("function")
        if not isinstance(function, dict):
            raise RequestContractError(400, "tool call function is invalid")
        name = _bounded_string(function.get("name"), "tool call name", 64)
        arguments = _bounded_string(function.get("arguments"), "tool call arguments", 8192)
        try:
            parsed_arguments = json.loads(
                arguments,
                object_pairs_hook=_object_without_duplicates,
                parse_constant=_reject_json_constant,
            )
        except (json.JSONDecodeError, ValueError, RecursionError) as exc:
            raise RequestContractError(400, "tool call arguments must be JSON") from exc
        if not isinstance(parsed_arguments, dict):
            raise RequestContractError(400, "tool call arguments must be an object")
        calls.append({"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}})
    return calls


def _validate_messages(raw_messages: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_messages, list) or not 1 <= len(raw_messages) <= MAX_MESSAGES:
        raise RequestContractError(400, "messages must be a non-empty bounded array")
    messages: list[dict[str, Any]] = []
    for raw_message in raw_messages:
        if not isinstance(raw_message, dict):
            raise RequestContractError(400, "each message must be an object")
        role = raw_message.get("role")
        if role not in ALLOWED_ROLES:
            raise RequestContractError(400, "message role is not supported")
        content = raw_message.get("content")
        if role == "assistant" and content is None and raw_message.get("tool_calls"):
            normalized_content: str | None = None
        else:
            normalized_content = _bounded_string(content, "message content", MAX_MESSAGE_CHARS)
        normalized: dict[str, Any] = {"role": role, "content": normalized_content}
        if "name" in raw_message:
            normalized["name"] = _bounded_string(raw_message["name"], "message name", 128)
        if "tool_call_id" in raw_message:
            normalized["tool_call_id"] = _bounded_string(raw_message["tool_call_id"], "tool call id", 128)
        if "tool_calls" in raw_message:
            if role != "assistant":
                raise RequestContractError(400, "only assistant messages may contain tool_calls")
            normalized["tool_calls"] = _validate_tool_calls(raw_message["tool_calls"])
        if role == "tool" and not normalized.get("tool_call_id"):
            raise RequestContractError(400, "tool messages require tool_call_id")
        messages.append(normalized)
    return messages


def _validate_tool_choice(raw_choice: Any, tool_names: set[str]) -> Any:
    if raw_choice is None:
        return raw_choice
    if isinstance(raw_choice, str) and raw_choice in {"none", "auto", "required"}:
        if raw_choice != "none" and not tool_names:
            raise RequestContractError(400, "tool_choice requires a supplied tool")
        return raw_choice
    if not isinstance(raw_choice, dict) or raw_choice.get("type") != "function":
        raise RequestContractError(400, "tool_choice is invalid")
    function = raw_choice.get("function")
    if not isinstance(function, dict) or function.get("name") not in tool_names:
        raise RequestContractError(400, "tool_choice must name a supplied tool")
    return {"type": "function", "function": {"name": function["name"]}}


def _validate_response_format(raw_format: Any) -> dict[str, str]:
    if not isinstance(raw_format, dict) or raw_format.get("type") not in ALLOWED_RESPONSE_FORMATS:
        raise RequestContractError(400, "response_format is not supported")
    return {"type": raw_format["type"]}


def _validate_payload(raw_payload: dict[str, Any]) -> dict[str, Any]:
    _check_json_shape(raw_payload)
    unknown_fields = set(raw_payload) - ALLOWED_TOP_LEVEL_FIELDS
    if unknown_fields:
        raise RequestContractError(400, "request contains unsupported fields")
    if raw_payload.get("model") != MODEL_NAME:
        raise RequestContractError(400, "model is not served by this endpoint")
    if "messages" not in raw_payload:
        raise RequestContractError(400, "messages is required")
    payload: dict[str, Any] = {
        "model": MODEL_NAME,
        "messages": _validate_messages(raw_payload["messages"]),
    }
    tools: list[dict[str, Any]] = []
    tool_names: set[str] = set()
    if "tools" in raw_payload:
        tools, tool_names = _validate_tools(raw_payload["tools"])
        if tools:
            payload["tools"] = tools
    if "tool_choice" in raw_payload:
        choice = _validate_tool_choice(raw_payload["tool_choice"], tool_names)
        if choice is not None:
            payload["tool_choice"] = choice
    if "temperature" in raw_payload:
        payload["temperature"] = _bounded_number(raw_payload["temperature"], "temperature", 0.0, 2.0)
    if "top_p" in raw_payload:
        payload["top_p"] = _bounded_number(raw_payload["top_p"], "top_p", 0.0, 1.0)
    if "presence_penalty" in raw_payload:
        payload["presence_penalty"] = _bounded_number(raw_payload["presence_penalty"], "presence_penalty", -2.0, 2.0)
    if "frequency_penalty" in raw_payload:
        payload["frequency_penalty"] = _bounded_number(raw_payload["frequency_penalty"], "frequency_penalty", -2.0, 2.0)
    if "seed" in raw_payload:
        payload["seed"] = _bounded_int(raw_payload["seed"], "seed", 0, 2**31 - 1)
    if "n" in raw_payload:
        if isinstance(raw_payload["n"], bool) or raw_payload["n"] != 1:
            raise RequestContractError(400, "only one completion is supported")
    if "stop" in raw_payload:
        stop = raw_payload["stop"]
        if isinstance(stop, str):
            payload["stop"] = _bounded_string(stop, "stop", MAX_STOP_CHARS)
        elif isinstance(stop, list) and len(stop) <= MAX_STOP_ITEMS:
            payload["stop"] = [_bounded_string(item, "stop", MAX_STOP_CHARS) for item in stop]
        else:
            raise RequestContractError(400, "stop is invalid")
    if "max_tokens" in raw_payload and "max_completion_tokens" in raw_payload:
        raise RequestContractError(400, "choose one output token limit")
    requested_output = raw_payload.get("max_tokens", raw_payload.get("max_completion_tokens", MAX_OUTPUT_TOKENS))
    payload["max_tokens"] = min(
        _bounded_int(requested_output, "max_tokens", 1, MAX_OUTPUT_TOKENS * 4), MAX_OUTPUT_TOKENS
    )
    if "stream" in raw_payload:
        if not isinstance(raw_payload["stream"], bool):
            raise RequestContractError(400, "stream must be boolean")
        payload["stream"] = raw_payload["stream"]
    else:
        payload["stream"] = False
    if "parallel_tool_calls" in raw_payload:
        if not isinstance(raw_payload["parallel_tool_calls"], bool):
            raise RequestContractError(400, "parallel_tool_calls must be boolean")
        payload["parallel_tool_calls"] = raw_payload["parallel_tool_calls"]
    if "response_format" in raw_payload:
        payload["response_format"] = _validate_response_format(raw_payload["response_format"])
    if "reasoning_effort" in raw_payload:
        if raw_payload["reasoning_effort"] not in ALLOWED_REASONING_EFFORTS:
            raise RequestContractError(400, "reasoning_effort is not supported")
        payload["reasoning_effort"] = raw_payload["reasoning_effort"]
    if "user" in raw_payload:
        payload["user"] = _bounded_string(raw_payload["user"], "user", MAX_USER_CHARS)
    if "metadata" in raw_payload:
        metadata = raw_payload["metadata"]
        if not isinstance(metadata, dict) or len(metadata) > MAX_METADATA_ENTRIES:
            raise RequestContractError(400, "metadata is invalid")
        normalized_metadata: dict[str, str] = {}
        for key, value in metadata.items():
            if not isinstance(key, str) or len(key) > 64:
                raise RequestContractError(400, "metadata key is invalid")
            normalized_metadata[key] = _bounded_string(value, "metadata value", MAX_METADATA_VALUE_CHARS)
        payload["metadata"] = normalized_metadata
    if "stream_options" in raw_payload:
        if not payload["stream"]:
            raise RequestContractError(400, "stream_options requires stream=true")
        stream_options = raw_payload["stream_options"]
        if not isinstance(stream_options, dict) or set(stream_options) - {"include_usage"}:
            raise RequestContractError(400, "stream_options is invalid")
        normalized_stream_options: dict[str, bool] = {}
        if "include_usage" in stream_options:
            if not isinstance(stream_options["include_usage"], bool):
                raise RequestContractError(400, "include_usage must be boolean")
            normalized_stream_options["include_usage"] = stream_options["include_usage"]
        payload["stream_options"] = normalized_stream_options
    if "chat_template_kwargs" in raw_payload:
        template_kwargs = raw_payload["chat_template_kwargs"]
        if not isinstance(template_kwargs, dict) or set(template_kwargs) - {"enable_thinking"}:
            raise RequestContractError(400, "chat_template_kwargs is invalid")
        if "enable_thinking" in template_kwargs and not isinstance(template_kwargs["enable_thinking"], bool):
            raise RequestContractError(400, "enable_thinking must be boolean")
        payload["chat_template_kwargs"] = {"enable_thinking": template_kwargs.get("enable_thinking", False)}
    return payload


def _response_content_type(payload: dict[str, Any]) -> str:
    return "text/event-stream" if payload["stream"] else "application/json"


async def _read_upstream_response(upstream: httpx.Response) -> bytes:
    content_length = upstream.headers.get("content-length")
    if content_length:
        try:
            declared_length = int(content_length)
        except ValueError as exc:
            raise ResponseContractError("upstream returned an invalid content length") from exc
        if declared_length < 0:
            raise ResponseContractError("upstream returned an invalid content length")
        if declared_length > MAX_RESPONSE_BYTES:
            raise ResponseContractError("upstream response is too large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in upstream.aiter_bytes():
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            raise ResponseContractError("upstream response is too large")
        chunks.append(chunk)
    return b"".join(chunks)


async def _bounded_stream(
    upstream: httpx.Response,
    client: httpx.AsyncClient,
    request_id: str,
) -> AsyncIterator[bytes]:
    total = 0
    try:
        async with asyncio.timeout(UPSTREAM_READ_TIMEOUT_SEC):
            async for chunk in upstream.aiter_bytes():
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    yield b'data: {"error":{"type":"response_limit","request_id":"' + request_id.encode() + b'"}}\n\n'
                    yield b"data: [DONE]\n\n"
                    return
                yield chunk
    except (TimeoutError, httpx.HTTPError, OSError):
        yield b'data: {"error":{"type":"upstream_error","request_id":"' + request_id.encode() + b'"}}\n\n'
        yield b"data: [DONE]\n\n"
    finally:
        await upstream.aclose()
        await client.aclose()


async def _forward_chat(payload: dict[str, Any], request_id: str) -> Response:
    timeout = httpx.Timeout(
        UPSTREAM_READ_TIMEOUT_SEC,
        connect=UPSTREAM_CONNECT_TIMEOUT_SEC,
        write=UPSTREAM_WRITE_TIMEOUT_SEC,
        pool=UPSTREAM_CONNECT_TIMEOUT_SEC,
    )
    client = httpx.AsyncClient(
        base_url=LOCAL_ORIGIN,
        timeout=timeout,
        limits=httpx.Limits(max_connections=MAX_CONCURRENT_INPUTS, max_keepalive_connections=2),
        trust_env=False,
        follow_redirects=False,
    )
    try:
        upstream_request = client.build_request(
            "POST",
            "/v1/chat/completions",
            json=payload,
            headers={"Accept": _response_content_type(payload), "Accept-Encoding": "identity"},
        )
        upstream = await client.send(upstream_request, stream=True)
    except asyncio.CancelledError:
        await client.aclose()
        raise
    except httpx.TimeoutException:
        await client.aclose()
        return _json_error(504, "upstream inference timed out", "upstream_timeout", request_id)
    except httpx.HTTPError:
        await client.aclose()
        return _json_error(502, "upstream inference is unavailable", "upstream_error", request_id)
    if upstream.status_code >= 400:
        await upstream.aclose()
        await client.aclose()
        return _json_error(502, "upstream inference request failed", "upstream_error", request_id)
    if upstream.headers.get("content-encoding", "identity").lower() != "identity":
        await upstream.aclose()
        await client.aclose()
        return _json_error(502, "upstream response encoding is not supported", "upstream_error", request_id)
    if payload["stream"]:
        return StreamingResponse(
            _bounded_stream(upstream, client, request_id),
            status_code=upstream.status_code,
            media_type="text/event-stream",
            headers=_response_headers(request_id),
        )
    try:
        async with asyncio.timeout(UPSTREAM_READ_TIMEOUT_SEC):
            body = await _read_upstream_response(upstream)
    except (TimeoutError, httpx.HTTPError, OSError, ResponseContractError):
        return _json_error(502, "upstream response exceeded the configured limit", "upstream_error", request_id)
    finally:
        await upstream.aclose()
        await client.aclose()
    try:
        json.loads(
            body,
            object_pairs_hook=_object_without_duplicates,
            parse_constant=_reject_json_constant,
        )
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return _json_error(502, "upstream returned an invalid response", "upstream_error", request_id)
    return Response(
        content=body,
        status_code=upstream.status_code,
        media_type="application/json",
        headers=_response_headers(request_id),
    )


async def _proxy_chat(request: Request) -> Response:
    request_id = secrets.token_hex(16)
    auth_failure = _check_bearer(request, request_id)
    if auth_failure is not None:
        return auth_failure
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        return _json_error(415, "content-type must be application/json", "unsupported_media_type", request_id)
    try:
        async with asyncio.timeout(REQUEST_READ_TIMEOUT_SEC):
            body = await _read_limited_body(request)
        payload = _validate_payload(_decode_payload(body))
    except TimeoutError:
        return _json_error(408, "request body read timed out", "request_timeout", request_id)
    except RequestContractError as exc:
        return _json_error(exc.status_code, exc.message, "invalid_request", request_id)
    return await _forward_chat(payload, request_id)


async def _models(request: Request) -> Response:
    request_id = secrets.token_hex(16)
    auth_failure = _check_bearer(request, request_id)
    if auth_failure is not None:
        return auth_failure
    return JSONResponse(
        {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "elastra"}]},
        headers=_response_headers(request_id),
    )


def _build_asgi_app() -> Starlette:
    return Starlette(
        routes=[
            Route("/v1/chat/completions", _proxy_chat, methods=["POST"]),
            Route("/v1/models", _models, methods=["GET"]),
        ],
        redirect_slashes=False,
    )


_validate_static_contract()

vllm_image = (
    modal.Image.from_registry(VLLM_IMAGE_REF, add_python="3.12")
    .entrypoint([])
    .uv_pip_install(
        "fastapi==0.136.0",
        "httpx==0.28.1",
        "huggingface-hub==0.36.2",
        "starlette==1.0.1",
        "tokenizers==0.22.2",
        "transformers==4.57.6",
    )
    .env(
        {
            "HF_HOME": HF_CACHE_PATH,
            "VLLM_CACHE_ROOT": VLLM_CACHE_PATH,
            "VLLM_SERVER_DEV_MODE": "0",
            "VLLM_MEDIA_URL_ALLOW_REDIRECTS": "0",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "TOKENIZERS_PARALLELISM": "false",
        }
    )
)

hf_cache_volume = modal.Volume.from_name(HF_CACHE_VOLUME_NAME, create_if_missing=True)
vllm_cache_volume = modal.Volume.from_name(VLLM_CACHE_VOLUME_NAME, create_if_missing=True)
app = modal.App(APP_NAME)


@app.cls(
    image=vllm_image,
    gpu="A100-40GB:1",
    scaledown_window=5 * MINUTES,
    timeout=STARTUP_TIMEOUT_SEC,
    startup_timeout=STARTUP_TIMEOUT_SEC,
    min_containers=0,
    max_containers=1,
    secrets=[modal.Secret.from_name(API_SECRET_NAME), modal.Secret.from_name(HF_SECRET_NAME)],
    volumes={HF_CACHE_PATH: hf_cache_volume, VLLM_CACHE_PATH: vllm_cache_volume},
)
@modal.concurrent(max_inputs=MAX_CONCURRENT_INPUTS)
class Model:
    @modal.enter()
    def startup(self) -> None:
        _validate_static_contract()
        _assert_vllm_version()
        _expected_bearer()
        self.process = subprocess.Popen(
            _build_vllm_command(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=_child_environment(),
            start_new_session=True,
        )
        try:
            _wait_for_readiness(self.process)
        except Exception:
            _stop_process(self.process)
            self.process = None
            raise

    @modal.exit()
    def stop(self) -> None:
        process = getattr(self, "process", None)
        _stop_process(process)
        self.process = None

    @modal.asgi_app(requires_proxy_auth=True)
    def serve(self) -> Starlette:
        return _build_asgi_app()
