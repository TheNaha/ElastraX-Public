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
        "--enable-reasoning",
        "--reasoning-parser", "deepseek_r1",
    ]
    if FAST_BOOT:
        cmd += ["--enforce-eager"]
    else:
        cmd += ["--no-enforce-eager"]
    cmd += ["--tensor-parallel-size", str(N_GPU)]
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


def warmup():
    """Run a few inference passes to warm up the engine."""
    payload = {
        "model": MODEL_NAME,
        "messages": [{"role": "user", "content": "Hello, how are you?"}],
        "max_tokens": 16,
    }
    for _ in range(3):
        req_lib.post(
            f"http://127.0.0.1:{VLLM_PORT}/v1/chat/completions",
            json=payload, timeout=60,
        ).raise_for_status()


def sleep_server(level=1):
    """Put vLLM into sleep mode (moves GPU tensors to CPU for snapshotting)."""
    req_lib.post(f"http://127.0.0.1:{VLLM_PORT}/sleep?level={level}").raise_for_status()


def wake_server():
    """Wake vLLM from sleep mode (restores GPU tensors)."""
    req_lib.post(f"http://127.0.0.1:{VLLM_PORT}/wake_up").raise_for_status()


# ## vLLM Server with GPU Snapshotting
#
# Uses vLLM's --enable-sleep-mode for proper GPU snapshotting:
# 1. snap=True:  Start vLLM → wait ready → warmup → sleep (GPU → CPU)
# 2. Snapshot:   Modal captures CPU + GPU memory state
# 3. snap=False: Wake up vLLM (CPU → GPU), ready to serve

app = modal.App("elastra-gpbot-vllm")


@app.cls(
    image=vllm_image,
    gpu=f"L40S:{N_GPU}",
    scaledown_window=3 * MINUTES,
    timeout=10 * MINUTES,
    volumes={
        "/root/.cache/huggingface": hf_cache_vol,
        "/root/.cache/vllm": vllm_cache_vol,
    },
    secrets=[modal.Secret.from_name("my-huggingface-secret")],
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
        print("✅ Server healthy. Running warmup...")
        warmup()
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
        self.process.terminate()

    @modal.web_server(port=VLLM_PORT, startup_timeout=10 * MINUTES)
    def serve(self):
        """Web server endpoint. vLLM is already running."""
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
