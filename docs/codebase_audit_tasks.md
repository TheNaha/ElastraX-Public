# Codebase Audit: Proposed Follow-up Tasks

This document captures four concrete tasks found during a quick codebase walkthrough.

## 1) Typo/Text Polish Task

**Task:** Fix awkward/incorrect capitalization in user-facing success copy for group actions.

- Current text uses title-case mid-sentence:
  - `✅ Successfully Added user {jid}.`
  - `✅ Successfully Removed user {jid}.`
- Proposed copy:
  - `✅ Successfully added user {jid}.`
  - `✅ Successfully removed user {jid}.`

**Why:** The current phrasing reads like a typo/grammar issue in production chat responses and is inconsistent with other messages.

**Files involved:**
- `src/utils/i18n.ts`
- `test/GroupAdminTool.test.ts` (update expected strings)

---

## 2) Bug Fix Task

**Task:** Make `user` optional in `GroupAdminTool` schema for actions that do not need a target user (`link`, `mute`, `unmute`).

- Current schema marks both `action` and `user` as required.
- Runtime logic does not require `user` for `link`, `mute`, and `unmute`.

**Why this is a bug:** Tool callers that respect JSON schema strictly can fail to invoke valid actions unless they supply a dummy `user`, causing avoidable tool-call failures.

**Files involved:**
- `src/tools/GroupAdminTool.ts`
- (optional) any schema/definition tests that assert required args.

---

## 3) Code Comment / Documentation Discrepancy Task

**Task:** Correct architecture documentation paths for providers.

- `docs/architecture.md` references:
  - `providers/whatsapp/`
  - `providers/discord/`
- Actual code uses files:
  - `src/providers/whatsapp.ts`
  - `src/providers/discord.ts`

**Why:** This mismatch can mislead contributors navigating the codebase and slows onboarding.

**Files involved:**
- `docs/architecture.md`

---

## 4) Test Improvement Task

**Task:** Add tests that cover no-user actions in `GroupAdminTool` (`link`, `mute`, `unmute`) and align the invalid-action expectation with current behavior.

Suggested additions:
- `execute({ action: 'link' })` succeeds without `user` when `getGroupInviteLink` is present.
- `execute({ action: 'mute' })` and `execute({ action: 'unmute' })` succeed without `user` when `setGroupSettings` exists.
- Invalid-action messaging/assertions should reflect the full action set, not only `add/remove`.

**Why:** Existing tests over-focus on add/remove flows and currently reinforce outdated behavior/messages.

**Files involved:**
- `test/GroupAdminTool.test.ts`
- `src/utils/i18n.ts` (if action error text is revised)
