# Experimental Modal adapter

`modal/app.py` is the only deployable Modal application in this directory. It defines the separate `elastra-x-vllm-experimental` app and is an experimental, private text and function/tool adapter around vLLM. It is not part of the bot's default startup or continuity path.

## Pinned runtime

- Model: `Qwen/Qwen3-8B`
- Model revision: `b968826d9c46dd6066d109eabc6255188de91218`
- vLLM: `0.16.0`
- Container: `vllm/vllm-openai@sha256:4801151759655c57606c844662e5213403c032a62d149c7ce61d615759a821ef`
- Python dependencies are exact-pinned in `pyproject.toml` and `constraints.txt`.
- Hugging Face and vLLM caches use model/revision/version-derived volume names. Changing the model, revision, cache layout, or image requires a new cache version.

The vLLM subprocess binds to `127.0.0.1`. Only the authenticated Starlette proxy is registered as a Modal web function; the raw vLLM port, development controls, metrics, and control routes are not registered.

## Authentication

The endpoint has two mandatory checks:

1. `requires_proxy_auth=True` makes the Modal edge reject requests without a Modal Proxy Token.
2. The application requires `Authorization: Bearer <token>` and compares it to `MODAL_PROXY_BEARER` (or one of the explicitly supported compatibility names) from the `elastra-api-secrets` Secret.

Create a workspace Proxy Token and store its combined bearer value in the application Secret using Modal's dashboard or secret manager (do not put the value in argv or shell history):

```text
modal workspace proxy-tokens create
```

The required Secret entries are:

- `elastra-api-secrets`: `MODAL_PROXY_BEARER=<combined-proxy-token>`
- `my-huggingface-secret`: `HF_TOKEN=<huggingface-token>`

The existing OpenAI client sends one `Authorization` header. For that client, configure its API key as the same combined Modal Proxy Token (`wk-...ws-...`) and configure the model name as `Qwen/Qwen3-8B`. A client using separate `Modal-Key` and `Modal-Secret` headers is also accepted when `MODAL_PROXY_BEARER` contains the corresponding combined value.

The API Secret is mandatory. Startup fails closed if no sufficiently long bearer secret is present. The vLLM child process receives a sanitized environment with application bearer variables removed, and request/response logging is disabled.

## Contract

The proxy exposes only these authenticated routes:

- `POST /v1/chat/completions` with OpenAI-style text messages and function tools
- `GET /v1/models`

The proxy rejects media content parts and media fields, arbitrary remote media URLs, unknown top-level fields, duplicate JSON keys, invalid JSON constants, non-text message content, and unsupported tool/response formats. It never fetches a URL supplied by a caller. Upstream requests use loopback, do not follow redirects, do not trust proxy environment variables, and have bounded timeouts.

The request and response limits are fixed in `app.py`:

- 256 KiB request body
- 2 MiB upstream response
- 64 messages and 64 function tools
- 32,000 characters per message
- 8,192 output tokens
- 8 concurrent inputs per container (one container maximum)
- 120-second upstream read timeout
- 15-second request-body read timeout
- 8-minute readiness deadline and 30-second process shutdown deadline

Tool calling uses vLLM's Hermes parser and Qwen3 reasoning parser. Tool names, schemas, calls, and arguments are bounded before the request reaches vLLM.

## Deploying

Deployment is intentionally not performed by this change. After reviewing the image digest, model revision, limits, and unsupported-feature list, an operator can run:

```text
modal deploy modal/app.py
```

The deployed URL is the experimental `elastra-x-vllm-experimental` endpoint; configure the bot's LLM base URL and combined bearer credential only after an explicit operator review. This task does not modify the repository's existing deployment defaults.

`modal/app.py` is the only supported experimental entrypoint. The old duplicate was removed so it cannot be deployed accidentally.

## Local smoke check

The smoke script is standard-library-only, performs no network calls, and cannot deploy anything:

```text
python3 modal/smoke.py
python3 -m py_compile modal/app.py modal/smoke.py
```

## Explicitly unsupported

This adapter does not claim support for ASR or automatic speech recognition, transcription uploads, audio/video/image input, full-omni generation, URL media fetching, embeddings, reranking, batch inference, GPU snapshots, raw vLLM control endpoints, or public unauthenticated access. These features are not supported here and require a separately designed and tested adapter; they are not silently emulated.
