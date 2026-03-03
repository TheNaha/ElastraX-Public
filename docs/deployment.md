# Deployment Guide

Deploying ElastraX v7 involves setting up the core application, configuring the database, and ensuring the AI providers are accessible. This guide covers the most common deployment scenarios.

## Prerequisites

Before you begin, ensure you have:
1.  **A Server/Environment:** This could be a local machine, a Virtual Private Server (VPS), or a container orchestration platform.
2.  **Node.js (via Bun):** ElastraX is built with the Bun runtime. Install Bun following the official instructions (`curl -fsSL https://bun.sh/install | bash`).
3.  **Environment Variables:** Prepare your `.env` file containing necessary API keys, database URLs, and configuration settings as outlined in the [Configuration Guide](./configuration.md).

## Deployment Methods

### 1. Docker (Recommended for Production)

Docker is the most robust and consistent way to deploy ElastraX. It encapsulates the application and its dependencies into an isolated container.

1.  **Build the Image:** Navigate to the project root and run:
    ```bash
    docker build -t elastrax-v7 .
    ```
2.  **Run the Container:**
    ```bash
    docker run -d --name elastrax \
      -v ./data:/app/data \
      -p 3000:3000 \
      --env-file .env \
      elastrax-v7
    ```
    *Explanation of flags:*
    - `-d`: Run in detached mode (background).
    - `--name elastrax`: Assign a recognizable name to the container.
    - `-v ./data:/app/data`: Mount a local directory (`./data`) to the container's data directory. This is crucial for persisting the SQLite database (`/app/data/db.sqlite`).
    - `-p 3000:3000`: Map the container's port to the host machine's port (if needed for the webhook server).
    - `--env-file .env`: Pass environment variables from your `.env` file.

### 2. Docker Compose (For Multi-Container Setups)

If you need to deploy ElastraX alongside other services (like a dedicated database or monitoring stack), Docker Compose simplifies the process.

1.  **Create a `docker-compose.yml`:** (Example structure)
    ```yaml
    version: '3.8'
    services:
      elastrax:
        build: .
        container_name: elastrax
        restart: unless-stopped
        env_file:
          - .env
        volumes:
          - ./data:/app/data
        ports:
          - "3000:3000"
    ```
2.  **Deploy:** Run `docker-compose up -d` in the same directory as the `docker-compose.yml` file.

### 3. Local Run (Development/Testing)

For development or quick testing, you can run ElastraX directly using Bun.

1.  **Install Dependencies:** `bun install`
2.  **Run Migrations:** Ensure the database schema is up-to-date: `bun run db:push`
3.  **Start the App:** `bun run dev` (for hot-reloading) or `bun start` (for a single run).

## Setting up Modal AI Infrastructure (Optional)

ElastraX includes scripts to deploy a private, OpenAI-compatible Llama 3 instance on Modal GPUs. This is highly recommended for performance and control.

1.  **Install Modal CLI:** `pip install modal`
2.  **Authenticate:** `modal setup`
3.  **Deploy:** Follow the specific instructions in the `modal/` directory (typically running the provided Python script).
4.  **Update `.env`:** Copy the generated endpoint URL and API key into your ElastraX `.env` file under the Modal AI provider settings.

## Database Migrations

Regardless of the deployment method, always ensure your database schema is current. ElastraX uses Drizzle ORM.

-   **Apply Changes:** `bun run db:push` (This connects to the database defined in your environment variables and applies necessary schema changes).

## First Startup & Authentication

On the first successful startup, the application (specifically the WhatsApp provider) will generate a QR code in the terminal logs.
1.  Open the WhatsApp application on your phone.
2.  Go to **Linked Devices** -> **Link a Device**.
3.  Scan the QR code displayed in your terminal.
4.  Once scanned, ElastraX will connect and begin handling messages. The connection state is persisted, so you won't need to re-scan unless the session expires or is manually disconnected.
