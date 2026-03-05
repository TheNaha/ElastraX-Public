# Architecture Overview

ElastraX v7 is a robust, multi-platform conversational AI agent built on a modern stack. This document outlines the key architectural components and their interactions.

## Core Principles

1.  **Unified Interface (`MessageContext`)**: The foundation of multi-platform support. Whether a message originates from WhatsApp or Discord, it is normalized into a standard `MessageContext` object. This shields the core logic from platform-specific APIs.
2.  **Agentic Framework**: The bot is not a simple command-response script. It uses Large Language Models (LLMs) to understand intent and can autonomously select and execute "tools" to fulfill complex requests.
3.  **Explicit Routing**: While capable of autonomous tool selection, ElastraX also supports direct slash-commands (e.g., `/search`) to bypass the LLM for predictable, fast execution.
4.  **Resilience**: Designed with failover mechanisms, primarily for LLM providers (e.g., falling back to Gemini if Modal is unavailable).

## Directory Structure & Component Roles

-   **`src/agent/` (The Brain)**:
    -   Contains the core conversational loop (`agent/index.ts`).
    -   Receives normalized `MessageContext` objects.
    -   Determines if a message is a direct command or requires LLM processing.
    -   Manages conversation history and invokes the LLM client.
-   **`src/ai/` (The Intelligence)**:
    -   Handles communication with OpenAI-compatible APIs (`ai/client.ts`).
    -   Implements provider failover logic.
    -   Translates `MessageContext` history into the specific JSON payload required by the LLM.
-   **`src/core/` (The Glue)**:
    -   Defines the central `MessageContext` interface.
    -   Contains utility functions and base classes used across the application.
-   **`src/db/` (The Memory)**:
    -   Uses Drizzle ORM and SQLite (`db/schema.ts`, `db/index.ts`).
    -   Responsible for persisting conversation history (crucial for LLM context), user configurations, and scheduled reminders.
-   **`src/providers/` (The Ears and Voice)**:
    -   Platform-specific adapters.
    -   **`src/providers/whatsapp.ts`**: Wraps the Baileys library to connect to WhatsApp. Converts Baileys messages into `MessageContext` and vice-versa.
    -   **`src/providers/discord.ts`**: Wraps discord.js for Discord connectivity.
-   **`src/tools/` (The Hands)**:
    -   A collection of independent modules implementing the `BaseTool` interface.
    -   Examples: `WebSearchTool`, `DownloadTool`, `PDFTool`.
    -   Each tool provides a definition schema to the LLM and an execution function.
-   **`src/webhookServer.ts` (The External Input)**:
    -   A fastify/express-based HTTP server.
    -   Allows external services (like GitHub Actions, Grafana alerts) to send messages into ElastraX chat rooms.

## Data Flow: Handling an Incoming Message

1.  **Ingestion**: A message arrives via a provider (e.g., WhatsApp).
2.  **Normalization**: The provider converts the raw platform message into a `MessageContext`.
3.  **Routing**: The `MessageContext` is passed to the core `agent/index.ts`.
4.  **Command Check**: If the message starts with a command prefix (e.g., `/ping`), the agent immediately executes the corresponding tool and returns the result.
5.  **LLM Processing**: If it's a conversational message:
    -   The agent retrieves conversation history from the database (`src/db/`).
    -   It builds a prompt containing the history and the list of available tools.
    -   It calls the `AIClient` (`src/ai/client.ts`).
6.  **Tool Invocation (Iterative Loop)**:
    -   The LLM responds, potentially requesting a tool call (e.g., "I need to search the web for 'latest news'").
    -   The agent executes the requested tool.
    -   The tool's result is appended to the context, and the LLM is called again.
    -   This loop continues until the LLM generates a final text response.
7.  **Delivery**: The final text (or media) response is passed back to the original provider, which formats and sends it to the user.
8.  **Persistence**: The exchange is saved to the SQLite database for future context.
