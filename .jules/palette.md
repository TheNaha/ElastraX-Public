## 2024-05-18 - [Consistent Tool Category Casing]
**Learning:** In the CLI/bot menu UX, inconsistent casing in configuration properties (e.g., `'Admin'` vs `'admin'`) can lead to duplicated categories being displayed if the rendering logic doesn't explicitly normalize strings. We noticed `ConfigTool` used uppercase 'A' while other admin tools used lowercase, potentially causing visual clutter in the `/menu` output before the fix was added in the MenuTool itself.
**Action:** Enforce consistent lowercase string literals for internal category keys across all tool definitions. Only capitalize the category string at the presentation layer when formatting the final output.

## 2025-03-03 - [Explicit Parameter Requirements in CLI]
**Learning:** In text-based CLI or conversational bot menus, relying solely on symbolic conventions (like `<required>` vs `[optional]`) for command usage is often insufficient for accessibility and clear UX. Explicitly labeling parameter descriptions with "Required" or "Optional" significantly improves readability and user comprehension. Additionally, ensuring consistent capitalization for metadata labels (like Category or Permissions) provides visual polish and consistency with other parts of the UI.
**Action:** When designing text-based help menus or usage instructions, explicitly spell out parameter requirement states alongside symbols, and normalize capitalization for displayed category strings at the presentation layer.

## 2025-03-06 - [Standardized List Formatting for Settings]
**Learning:** Text-based menus (such as the configuration viewer in `ConfigTool`) suffer in readability when they use harsh, all-caps bracketed tags (e.g. `[DEFAULT (env)]`) and rely purely on spaces for indentation. A simple list styling using standard bullet points (`•`) and properly capitalized text inside parentheses (e.g. `(Default)`) makes the dense information much easier to scan and feels significantly more polished.
**Action:** Apply a consistent text formatting pattern across list-based UI outputs. Use standard bullets (`•`) instead of spaces, and reserve all-caps for distinct category headers rather than inline status tags.
## 2025-03-09 - [Fuzzy Search for Menu Suggestions]
**Learning:** The "Did you mean?" functionality for incorrect slash commands exists in the agent logic, but the interactive help menu `/menu <command>` lacked it, leading to a dead-end experience when users made typos.
**Action:** Reuse existing Levenshtein distance utilities in text-based search inputs to suggest valid options when users mistype queries.
## 2024-05-24 - [Consistent Conversational UI Menus]
**Learning:** In text-based conversational interfaces (like WhatsApp bots), using consistent title-cased labels in parentheses (e.g., `(Default: x)`, `(Custom)`) and standardized bullet points (`•`) across all tool menus significantly improves scannability and accessibility for screen readers compared to mixed conventions (lowercase, hyphens, ASCII symbols).
**Action:** Standardize parameter and status lists across all tools (e.g. `RoleTool`, `MenuTool`) to use `•` bullets and Title Case parentheticals.

## 2025-03-14 - [Consistent Bulleted Lists for Metadata]
**Learning:** Text-based bots often output metadata (e.g. system stats, command help) as raw multiline strings. Relying purely on newlines makes the text dense and harder to scan. Introducing a simple bullet prefix (` • `) for each key-value pair creates a clear, aligned list format that significantly improves visual scanning and readability.
**Action:** Always format consecutive key-value metadata lines (like those in `MenuTool` help, `StatsTool`, and `OwnerTool` system info) as proper bulleted lists using ` • ` instead of plain text on newlines.

## 2025-03-16 - [List Formatting Optimization]
**Learning:** In chat-based text interfaces, placing a leading space before list bullets (e.g., ` • ` instead of `• `) improves readability by providing subtle visual padding from the edge of the chat bubble.
**Action:** Always format text-based lists with a leading space before the bullet point (` • `) to enhance the visual scanning experience for the user.

## 2024-03-21 - Format Technical Parameters as Code in Text-Based UIs
**Learning:** In purely text-based interfaces like WhatsApp or Telegram, technical strings (like command usages, IDs, or exact parameter options) can blend into normal text, making them hard to scan or tap-to-copy.
**Action:** Always wrap exact commands (e.g. `/menu get`), identifiers, or parameter enum values (e.g. `get` | `set`) in backticks. This applies standard Markdown code formatting, which text-based clients usually render as monospaced text, visually isolating it from prose and improving copyability.

## 2025-03-18 - [Double Newlines for Visual Separation in Lists]
**Learning:** In conversational UI outputs, formatting text-based lists with single newlines can still appear cluttered and difficult to read, especially when list items contain multiple details or wrap on mobile screens.
**Action:** Always use double newlines (`\n\n`) alongside leading space bullets (` • `) to provide clear visual separation between distinct list items or sections, significantly enhancing visual scanning and readability.
## 2024-05-18 - [Markdown code formatting in bot responses]
**Learning:** Formatting parameter string aliases using markdown code blocks inside WhatsApp bots allows the options to be visually separated from standard text, increasing tap-to-copy functionality and overall legibility of commands in list items.
**Action:** Use backticks (\` \`) to wrap inline aliases and commands in bot conversational tool responses such as the `MenuTool.ts` main menu listing.

## 2025-03-30 - [Copyable Technical Keywords in Bot Outputs]
**Learning:** We noticed that `/config` (ConfigTool) presented config key properties in Title Case inside its bullet list (e.g. `*System Prompt*`). While this looks nice, it breaks UX because the actual key needed for the `/config set` command is exact (`systemPrompt`). Users must type the exact case-sensitive programmatic string, and failing to provide it easily tappable/copyable creates a poor experience. Additionally, metadata like `platform` and `permissions` in `IDTool` lacked title casing, reducing visual polish.
**Action:** When displaying exact programmatic strings that users must type (like config keys), format them using markdown backticks (e.g., `*\`systemPrompt\`*`) to render them as copyable code snippets in the chat client. Conversely, when displaying human-readable metadata values (like roles or platform names), apply Title Casing at the presentation layer for polish.

## 2025-04-03 - [Consistent List Formatting for Actionable Items]
**Learning:** We noticed that lists requiring user interaction (like cancellation IDs in `ReminderTool`) were using numbered lists (`1. `) and single newlines, which broke the visual consistency of using leading space bullets (` • `) and double newlines (`\n\n`) across the bot's UI. This made dense lists harder to scan.
**Action:** When list items require an identifier for future interactions, move the identifier into parentheses alongside the text (e.g., `(ID: 1)`) so the primary list formatting can still utilize leading space bullets (` • `) and double newlines for optimal visual padding and scanning.
