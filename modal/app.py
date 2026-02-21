# Based on the official Modal vLLM OpenAI-compatible server example
import modal

vllm_image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install(
        "vllm==0.5.1",
        "fastapi[standard]",
    )
)

app = modal.App("elastra-gpbot-vllm")
MODEL_NAME = "meta-llama/Meta-Llama-3-8B-Instruct"

@app.function(
    image=vllm_image,
    gpu="L4",
    allow_concurrent_inputs=100,
    keep_warm=0,
    secrets=[modal.Secret.from_name("my-huggingface-secret")],
    timeout=60 * 10,
)
@modal.asgi_app()
def fastapi_app():
    import fastapi
    from vllm.entrypoints.openai.api_server import build_async_engine_client, router
    from vllm.entrypoints.openai.cli_args import make_arg_parser
    
    parser = make_arg_parser()
    args = parser.parse_args([
        "--model", MODEL_NAME,
        "--gpu-memory-utilization", "0.90",
    ])
    
    app_server = fastapi.FastAPI(
        title="ElastraGPBOT vLLM Server",
        description="OpenAI-Compatible vLLM Server deployed on Modal",
    )
    
    app_server.include_router(router)
    
    # We delay engine creation until the app runs
    # This is handled automatically by vllm's entrypoint in standard ways,
    # but for Modal we often just run the server directly or mount it.
    
    return app_server
