---
name: send-to-sticky-pad
description: Turn a finished project plan into a complete Hermes Markdown task and open it in the native Sticky Pad macOS app. Use when the user says planning is complete, asks to send or push a plan to Sticky Pad, or asks to open an existing Sticky Pad task.
---

# Send to Sticky Pad

Use the bundled `sticky-pad` MCP tools. The MCP writes only inside `~/Documents/Sticky Pad`.

## New finished plan

1. Confirm from the conversation that project planning is finished. Do not deposit an exploratory draft as a final agent task.
2. Read [Hermes-Task-Template.txt](references/Hermes-Task-Template.txt) completely.
3. Fill the template from the finished plan. Remove unused placeholders and the template's ChatGPT instruction. Preserve the persistent state files, ten-step cycle, evidence gates, phase-specific tests, ADVANCE/REPEAT/BLOCKED decisions, recovery rules, protected areas, and final regression gate.
4. Do not invent repository paths, credentials, exact commands, device results, or evidence. Record unresolved implementation choices under undefined decisions; treat unavailable external verification as a blocker.
5. Run the template's pre-deposit quality check.
6. Call `sticky_pad_create_and_open_task` once with a short title and the complete Markdown.
7. Treat the tool result as authoritative. Report the returned filename. Claim the desktop-open request only when `openRequested` is `true`.

If creation succeeds but `openRequested` is `false`, do not create a duplicate. Call `sticky_pad_open_task` with the returned filename once. If that fails, report that the `.md` exists but the native app did not receive the open request.

## Existing task

Read the existing task before revising it. Use `sticky_pad_update_task` only when the user asked to change that task, then call `sticky_pad_open_task` if they want it visible. Never overwrite a task merely because its title resembles the current plan.

## Boundaries

- Creating or updating a task is a local write and may require the product's normal confirmation.
- Never claim that Sticky Pad displayed a note based only on generated Markdown. Require a successful open-request result; verify the visible native note when computer control is available.
- Do not retry a non-idempotent create after an uncertain result. List projects first and reconcile by filename.
