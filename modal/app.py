# ---
# pytest: false
# ---

# # ElastraGPBOT — OpenAI-compatible Qwen3-Omni server on Modal
#
# Serves `cyankiwi/Qwen3-Omni-30B-A3B-Instruct-AWQ-4bit` via vLLM
# with an OpenAI-compatible API, GPU snapshotting, and multimodal support.
#
# Deploy:  modal deploy modal/app.py
# Test:    modal run modal/app.py

import asyncio
import json
import os
import socket
import subprocess
import time

import aiohttp
import modal

MINUTES = 60  # seconds

# ## Container Image

vllm_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.0-devel-ubuntu22.04", add_python="3.12"
    )
    .entrypoint([])
    .uv_pip_install(
        "vllm",
        "transformers<=4.57.3",
        "huggingface-hub",
        "qwen-omni-utils",
        "requests",
    )
    # Monkey patch for vllm/transformers tokenizer compat issue
    # See: https://github.com/vllm-project/vllm/issues/13127
    .run_commands(
        "SITE=$(python -c \"import site; print(site.getsitepackages()[0])\") && "
        "printf 'import transformers\\nif not hasattr(transformers.tokenization_utils_base.PreTrainedTokenizerBase, \"all_special_tokens_extended\"):\\n    transformers.tokenization_utils_base.PreTrainedTokenizerBase.all_special_tokens_extended = property(lambda self: self.all_special_tokens)\\n' > $SITE/sitecustomize.py"
    )
    .env({
        "HF_XET_HIGH_PERFORMANCE": "1",
        "VLLM_SERVER_DEV_MODE": "1",
        # Reduce noisy C++/distributed warnings in Modal logs
        "TORCH_CPP_LOG_LEVEL": "ERROR",
        "TORCH_DISTRIBUTED_DEBUG": "OFF",
        "NCCL_DEBUG": "ERROR",
    })
)

# ## Model Configuration

MODEL_NAME = "cyankiwi/Qwen3-Omni-30B-A3B-Instruct-AWQ-4bit"
MODEL_REVISION = "main"

# ## Volumes

hf_cache_vol = modal.Volume.from_name("elastra-hf-cache", create_if_missing=True)
vllm_cache_vol = modal.Volume.from_name("elastra-vllm-cache", create_if_missing=True)

# ## Configuration

FAST_BOOT = True
N_GPU = 1
VLLM_PORT = 8000
MIN_CONTAINERS = 0

# Modal secret names
# - my-huggingface-secret: HF token(s)
# - elastra-api-secrets: API keys (OPENAI_API_KEY, VLLM_API_KEY, WHISPER_API_KEY)
HF_SECRET_NAME = "my-huggingface-secret"
API_SECRET_NAME = "elastra-api-secrets"

# API key lookup priority
VLLM_API_KEY_ENV_NAMES = ("OPENAI_API_KEY", "VLLM_API_KEY")
WHISPER_API_KEY_ENV_NAMES = ("WHISPER_API_KEY", "OPENAI_API_KEY", "VLLM_API_KEY")

# Whisper API defaults
WHISPER_MODEL = "Systran/faster-whisper-large-v3"
WHISPER_GPU = "L4"

# Whisper ASR Box container defaults
WHISPER_BOX_IMAGE = "onerahmet/openai-whisper-asr-webservice:latest-gpu"
WHISPER_BOX_PORT = 9000
WHISPER_BOX_GPU = "L4"
WHISPER_BOX_MODEL_PATH = "/data/whisper"
WHISPER_BOX_ENGINE = "whisperx"
WHISPER_BOX_MODEL = "large-v3"

# ## Helper Functions

with vllm_image.imports():
    import requests as req_lib


def _build_vllm_cmd():
    """Build the vLLM serve command."""
    cmd = [
        "vllm", "serve",
        "--uvicorn-log-level", "info",
        MODEL_NAME,
        "--revision", MODEL_REVISION,
        "--served-model-name", MODEL_NAME,
        "--host", "0.0.0.0",
        "--port", str(VLLM_PORT),
        "--max-model-len", "32768",
        "--gpu-memory-utilization", "0.90",
        "--limit-mm-per-prompt", '{"image":3,"video":1,"audio":3}',
        "--max-num-seqs", "8",
        "--trust-remote-code",
        "--enable-sleep-mode",  # Required for GPU snapshotting
        # Tool/function calling support (Qwen uses Hermes format)
        "--enable-auto-tool-choice",
        "--tool-call-parser", "hermes",
        # Reasoning/chain-of-thought support
        "--reasoning-parser", "qwen3",
    ]
    if FAST_BOOT:
        cmd += ["--enforce-eager"]
    else:
        cmd += ["--no-enforce-eager"]
    cmd += ["--tensor-parallel-size", str(N_GPU)]

    api_key = next((os.environ.get(k) for k in VLLM_API_KEY_ENV_NAMES if os.environ.get(k)), None)
    if api_key:
        cmd += ["--api-key", api_key]

    return cmd


def wait_ready(process, timeout=5 * MINUTES):
    """Poll vLLM health endpoint until ready."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            _check_running(process)
            req_lib.get(f"http://127.0.0.1:{VLLM_PORT}/health").raise_for_status()
            return
        except (subprocess.CalledProcessError, req_lib.exceptions.ConnectionError, req_lib.exceptions.HTTPError):
            time.sleep(5)
    raise TimeoutError(f"vLLM server not ready within {timeout} seconds")


def _check_running(p):
    if (rc := p.poll()) is not None:
        raise subprocess.CalledProcessError(rc, cmd=p.args)


def sleep_server(level=1):
    """Put vLLM into sleep mode (moves GPU tensors to CPU for snapshotting)."""
    req_lib.post(f"http://127.0.0.1:{VLLM_PORT}/sleep?level={level}").raise_for_status()


def wake_server():
    """Wake vLLM from sleep mode (restores GPU tensors)."""
    req_lib.post(f"http://127.0.0.1:{VLLM_PORT}/wake_up").raise_for_status()


def _wait_for_port(port: int, timeout: int = 5 * MINUTES):
    """Wait for a local TCP port to accept connections."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                return
        except OSError:
            time.sleep(1)
    raise TimeoutError(f"Service on port {port} not ready within {timeout} seconds")


# ## vLLM Server with GPU Snapshotting
#
# Uses vLLM's --enable-sleep-mode for proper GPU snapshotting:
# 1. snap=True:  Start vLLM → wait ready → warmup → sleep (GPU → CPU)
# 2. Snapshot:   Modal captures CPU + GPU memory state
# 3. snap=False: Wake up vLLM (CPU → GPU), ready to serve

app = modal.App("elastra-gpbot-vllm")

whisper_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.0-devel-ubuntu22.04", add_python="3.12"
    )
    .entrypoint([])
    .uv_pip_install(
        "fastapi",
        "python-multipart",
        "faster-whisper",
    )
    .env({
        "HF_XET_HIGH_PERFORMANCE": "1",
    })
)

whisper_box_image = (
    modal.Image.from_registry(WHISPER_BOX_IMAGE)
    .entrypoint([])
)


@app.cls(
    image=vllm_image,
    gpu=f"A100-40GB:{N_GPU}",
    scaledown_window=1 * MINUTES,
    timeout=10 * MINUTES,
    volumes={
        "/root/.cache/huggingface": hf_cache_vol,
        "/root/.cache/vllm": vllm_cache_vol,
    },
    secrets=[
        modal.Secret.from_name(HF_SECRET_NAME),
        modal.Secret.from_name(API_SECRET_NAME),
    ],
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    min_containers=MIN_CONTAINERS,
)
@modal.concurrent(max_inputs=32)
class Model:
    @modal.enter(snap=True)
    def startup(self):
        """Start vLLM, wait for health, warm up, then put to sleep for snapshot."""
        cmd = _build_vllm_cmd()
        print(f"🚀 Starting vLLM: {' '.join(cmd)}")
        self.process = subprocess.Popen(cmd)

        print("⏳ Waiting for model to load...")
        wait_ready(self.process)
        print("� Putting vLLM to sleep for GPU snapshot...")
        sleep_server(1)
        print("📸 Ready for snapshot.")

    @modal.enter(snap=False)
    def restore(self):
        """Wake vLLM from sleep mode after restoring from snapshot."""
        print("⚡ Waking vLLM from sleep mode...")
        wake_server()
        print("✅ Restored from GPU snapshot — server ready!")

    @modal.exit()
    def stop(self):
        # Graceful teardown first to reduce noisy NCCL/TCPStore broken-pipe logs.
        try:
            sleep_server(1)
        except Exception:
            pass

        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.process.kill()

    @modal.web_server(port=VLLM_PORT, startup_timeout=10 * MINUTES)
    def serve(self):
        """Web server endpoint. vLLM is already running."""
        pass


@app.cls(
    image=whisper_image,
    gpu=WHISPER_GPU,
    scaledown_window=1 * MINUTES,
    timeout=10 * MINUTES,
    volumes={
        "/root/.cache/huggingface": hf_cache_vol,
    },
    secrets=[
        modal.Secret.from_name(HF_SECRET_NAME),
        modal.Secret.from_name(API_SECRET_NAME),
    ],
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    min_containers=0,
)
@modal.concurrent(max_inputs=32)
class WhisperAPI:
    @modal.enter(snap=True)
    def startup(self):
        from faster_whisper import WhisperModel

        model_name = os.environ.get("WHISPER_MODEL", WHISPER_MODEL)
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "float16")
        print(f"🎙️ Loading Whisper model: {model_name} ({compute_type})")
        self.model = WhisperModel(
            model_name,
            device="cuda",
            compute_type=compute_type,
        )
        print("📸 Whisper model loaded and ready for snapshot.")

    @modal.enter(snap=False)
    def restore(self):
        print("⚡ Whisper restored from GPU snapshot — ready!")

    @modal.asgi_app()
    def serve(self):
        """
        OpenAI-compatible Whisper-style endpoint:
            POST /v1/audio/transcriptions

        Auth:
            - If VLLM_API_KEY or OPENAI_API_KEY is set, requires
              Authorization: Bearer <key>
        """
        from fastapi import FastAPI, File, Form, Header, HTTPException, Query, UploadFile
        from fastapi.responses import JSONResponse, PlainTextResponse
        import tempfile

        app_api = FastAPI(title="Elastra Whisper API")

        def _expected_api_key() -> str | None:
            for key in WHISPER_API_KEY_ENV_NAMES:
                value = os.environ.get(key)
                if value:
                    return value
            return None

        def _check_bearer(authorization: str | None) -> None:
            expected = _expected_api_key()
            if not expected:
                return
            if not authorization or not authorization.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Missing bearer token")
            received = authorization[len("Bearer "):].strip()
            if received != expected:
                raise HTTPException(status_code=401, detail="Invalid API key")

        def _format_timestamp(seconds: float, decimal_marker: str = ".") -> str:
            millis = max(0, int(round(seconds * 1000.0)))
            hours = millis // 3_600_000
            millis %= 3_600_000
            minutes = millis // 60_000
            millis %= 60_000
            secs = millis // 1000
            ms = millis % 1000
            return f"{hours:02d}:{minutes:02d}:{secs:02d}{decimal_marker}{ms:03d}"

        def _build_vtt(segment_items) -> str:
            lines = ["WEBVTT", ""]
            for seg in segment_items:
                lines.append(
                    f"{_format_timestamp(seg.start)} --> {_format_timestamp(seg.end)}"
                )
                lines.append(seg.text.strip())
                lines.append("")
            return "\n".join(lines).strip() + "\n"

        def _build_srt(segment_items) -> str:
            lines = []
            for idx, seg in enumerate(segment_items, start=1):
                lines.append(str(idx))
                lines.append(
                    f"{_format_timestamp(seg.start, ',')} --> {_format_timestamp(seg.end, ',')}"
                )
                lines.append(seg.text.strip())
                lines.append("")
            return "\n".join(lines).strip() + "\n"

        def _build_tsv(segment_items) -> str:
            lines = ["start\tend\ttext"]
            for seg in segment_items:
                lines.append(f"{seg.start:.3f}\t{seg.end:.3f}\t{seg.text.strip()}")
            return "\n".join(lines) + "\n"

        async def _run_transcription(
            *,
            upload: UploadFile,
            task: str,
            language: str | None,
            prompt: str | None,
            vad_filter: bool,
            word_timestamps: bool,
        ):
            suffix = os.path.splitext(upload.filename or "audio.bin")[1] or ".bin"
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(await upload.read())
                tmp_path = tmp.name

            try:
                segments, info = self.model.transcribe(
                    tmp_path,
                    task=task,
                    language=language,
                    initial_prompt=prompt,
                    vad_filter=vad_filter,
                    word_timestamps=word_timestamps,
                )
                segment_items = list(segments)
                text = "".join(s.text for s in segment_items).strip()
                return text, segment_items, info
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

        def _segment_to_json(idx: int, seg, include_words: bool) -> dict:
            item = {
                "id": idx,
                "start": seg.start,
                "end": seg.end,
                "text": seg.text,
                "tokens": list(seg.tokens) if getattr(seg, "tokens", None) is not None else None,
            }
            for key in ("seek", "temperature", "avg_logprob", "compression_ratio", "no_speech_prob"):
                value = getattr(seg, key, None)
                if value is not None:
                    item[key] = value
            if include_words and getattr(seg, "words", None):
                item["words"] = [
                    {
                        "word": word.word,
                        "start": word.start,
                        "end": word.end,
                        "probability": getattr(word, "probability", None),
                    }
                    for word in seg.words
                ]
            return item

        @app_api.post("/asr")
        async def asr(
            audio_file: UploadFile = File(...),
            output: str = Query(default="text", pattern="^(text|json|vtt|srt|tsv)$"),
            task: str = Query(default="transcribe", pattern="^(transcribe|translate)$"),
            language: str | None = Query(default=None),
            word_timestamps: bool = Query(default=False),
            vad_filter: bool = Query(default=False),
            encode: bool = Query(default=True),
            diarize: bool = Query(default=False),
            min_speakers: int | None = Query(default=None),
            max_speakers: int | None = Query(default=None),
            authorization: str | None = Header(default=None, alias="Authorization"),
        ):
            _check_bearer(authorization)
            del encode, diarize, min_speakers, max_speakers

            text, segment_items, info = await _run_transcription(
                upload=audio_file,
                task=task,
                language=language,
                prompt=None,
                vad_filter=vad_filter,
                word_timestamps=word_timestamps,
            )

            if output == "text":
                return PlainTextResponse(text)
            if output == "vtt":
                return PlainTextResponse(_build_vtt(segment_items), media_type="text/vtt")
            if output == "srt":
                return PlainTextResponse(_build_srt(segment_items), media_type="application/x-subrip")
            if output == "tsv":
                return PlainTextResponse(_build_tsv(segment_items), media_type="text/tab-separated-values")

            return JSONResponse({
                "text": text,
                "language": getattr(info, "language", None),
                "segments": [
                    _segment_to_json(idx, seg, include_words=word_timestamps)
                    for idx, seg in enumerate(segment_items)
                ],
            })

        @app_api.post("/detect-language")
        async def detect_language(
            audio_file: UploadFile = File(...),
            authorization: str | None = Header(default=None, alias="Authorization"),
        ):
            _check_bearer(authorization)

            _, _, info = await _run_transcription(
                upload=audio_file,
                task="transcribe",
                language=None,
                prompt=None,
                vad_filter=False,
                word_timestamps=False,
            )

            lang_code = getattr(info, "language", None)
            lang_prob = getattr(info, "language_probability", None)
            language_names = {
                "en": "english",
                "id": "indonesian",
                "fr": "french",
                "de": "german",
                "es": "spanish",
                "it": "italian",
                "pt": "portuguese",
                "tr": "turkish",
                "ja": "japanese",
                "ko": "korean",
                "zh": "chinese",
                "ru": "russian",
                "ar": "arabic",
                "hi": "hindi",
                "nl": "dutch",
                "pl": "polish",
                "uk": "ukrainian",
                "vi": "vietnamese",
                "th": "thai",
            }
            return JSONResponse({
                "detected_language": language_names.get(lang_code, lang_code),
                "language_code": lang_code,
                "confidence": lang_prob,
            })

        @app_api.get("/health")
        async def health():
            return {"ok": True, "service": "whisper"}

        @app_api.post("/v1/audio/transcriptions")
        async def transcriptions(
            file: UploadFile = File(...),
            model: str = Form("whisper-1"),
            language: str | None = Form(None),
            prompt: str | None = Form(None),
            response_format: str = Form("json"),
            temperature: float = Form(0.0),
            authorization: str | None = Header(default=None, alias="Authorization"),
        ):
            _check_bearer(authorization)
            del model, temperature

            text, segment_items, info = await _run_transcription(
                upload=file,
                task="transcribe",
                language=language,
                prompt=prompt,
                vad_filter=True,
                word_timestamps=False,
            )

            if response_format == "text":
                return PlainTextResponse(text)

            if response_format == "verbose_json":
                return JSONResponse({
                    "task": "transcribe",
                    "language": info.language,
                    "duration": info.duration,
                    "text": text,
                    "segments": [
                        {
                            "id": idx,
                            "start": seg.start,
                            "end": seg.end,
                            "text": seg.text,
                        }
                        for idx, seg in enumerate(segment_items)
                    ],
                })

            return JSONResponse({"text": text})

        return app_api


@app.cls(
    image=whisper_box_image,
    gpu=WHISPER_BOX_GPU,
    scaledown_window=1 * MINUTES,
    timeout=20 * MINUTES,
    volumes={
        WHISPER_BOX_MODEL_PATH: hf_cache_vol,
    },
    secrets=[
        modal.Secret.from_name(HF_SECRET_NAME),
    ],
    min_containers=0,
)
@modal.concurrent(max_inputs=16)
class WhisperASRBox:
    @modal.enter()
    def startup(self):
        # Prevent /root/app.py (this Modal file) from shadowing upstream `app` package.
        child_env = os.environ.copy()
        raw_pythonpath = child_env.get("PYTHONPATH", "")
        kept_parts = [
            part
            for part in raw_pythonpath.split(":")
            if part and not part.startswith("/root")
        ]
        child_env["PYTHONPATH"] = ":".join(["/app", *kept_parts])
        # Force-set regardless of inherited env (do not use setdefault — @app.cls
        # env= dict is already in os.environ and would win over setdefault).
        child_env["ASR_ENGINE"] = WHISPER_BOX_ENGINE
        child_env["ASR_MODEL"] = WHISPER_BOX_MODEL
        child_env["ASR_MODEL_PATH"] = WHISPER_BOX_MODEL_PATH

        cmd = [
            "whisper-asr-webservice",
            "--host",
            "0.0.0.0",
            "--port",
            str(WHISPER_BOX_PORT),
        ]
        print(f"🚀 Starting Whisper ASR Box: {' '.join(cmd)}")
        self.process = subprocess.Popen(cmd, cwd="/app", env=child_env)

        _wait_for_port(WHISPER_BOX_PORT, timeout=8 * MINUTES)
        print("✅ Whisper ASR Box is ready")

    @modal.exit()
    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.process.kill()

    @modal.web_server(port=WHISPER_BOX_PORT, startup_timeout=10 * MINUTES)
    def serve(self):
        pass


# ## Test Entrypoint

@app.local_entrypoint()
async def test(test_timeout=10 * MINUTES, content=None, twice=True):
    model = Model()
    url = await model.serve.get_web_url.aio()

    system_prompt = {
        "role": "system",
        "content": "You are ElastraX, a helpful and friendly AI personal assistant.",
    }
    if content is None:
        content = "Hello! What model are you running on? Reply in one sentence."

    messages = [
        system_prompt,
        {"role": "user", "content": content},
    ]

    async with aiohttp.ClientSession(base_url=url) as session:
        print(f"Running health check for server at {url}")
        async with session.get(
            "/health", timeout=aiohttp.ClientTimeout(total=test_timeout - 1 * MINUTES)
        ) as resp:
            up = resp.status == 200
        assert up, f"Failed health check for server at {url}"
        print(f"Successful health check for server at {url}")

        print(f"Sending messages to {url}:", *messages, sep="\n\t")
        await _send_request(session, MODEL_NAME, messages)
        if twice:
            messages[0]["content"] = "You are a pirate assistant who speaks like a pirate."
            print(f"Sending messages to {url}:", *messages, sep="\n\t")
            await _send_request(session, MODEL_NAME, messages)


async def _send_request(session, model, messages):
    payload = {"messages": messages, "model": model, "stream": True}
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    api_key = next((os.environ.get(k) for k in VLLM_API_KEY_ENV_NAMES if os.environ.get(k)), None)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with session.post(
        "/v1/chat/completions", json=payload, headers=headers
    ) as resp:
        async for raw in resp.content:
            resp.raise_for_status()
            line = raw.decode().strip()
            if not line or line == "data: [DONE]":
                continue
            if line.startswith("data: "):
                line = line[len("data: "):]

            chunk = json.loads(line)
            assert chunk["object"] == "chat.completion.chunk"
            print(chunk["choices"][0]["delta"]["content"], end="")
    print()
