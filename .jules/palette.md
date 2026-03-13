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

## 2025-03-10 - [Standardized List Item Markers and Casing]
**Learning:** In text-based informational outputs (like `/role privs`, `/stats`, or `/owner system_info`), list items without standard markers (`•`) or with inconsistent capitalization (e.g., lowercase "unlimited" alongside title-case "Default") make the text harder to scan and reduce the feeling of polish.
**Action:** When returning multiline informational lists, consistently use standard bullet points (`•`) for each item and ensure key value terms (like "Unlimited", "Global") are appropriately capitalized to match adjacent labels.
