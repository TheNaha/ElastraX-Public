## 2025-02-14 - Unbounded Configuration Inputs (DoS)
**Vulnerability:** The `ConfigTool` allowed users to set `contextLimit` to arbitrary integer values (e.g., 1,000,000). This could lead to Denial of Service (DoS) by causing the bot to fetch excessive database rows and overload the LLM context window.
**Learning:** Input validation was missing for configuration values. Developers often trust admin inputs, but in this bot, "admin" privileges are granted to any user in their own DM session.
**Prevention:** Always validate and bound numeric inputs, especially those that control resource usage (like database limits or API parameters).
