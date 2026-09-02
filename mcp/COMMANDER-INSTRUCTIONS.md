<!-- sticky-pad-quiet-pull:v1 -->
## Sticky Pad quiet-pull inbox

- Treat `sticky-pad-inbox` as a quiet visibility queue, never as automatic dispatch. New cards must not interrupt active work or generate messaging-platform notifications merely because they exist.
- Check only at a safe idle boundary, when the user asks for the next task, or when explicitly asked to check Sticky Pad. Do not poll during active work.
- Inspect only with `sticky_pad_inbox_list` and `sticky_pad_inbox_read`. Confirm the card is blocked and unassigned, the Markdown attachment exists, and its SHA-256 matches the source hash recorded on the card.
- When explicitly asked to report readiness, acknowledge exactly once: `READY-SEEN` after a valid read, `READY-MISMATCH` on any mismatch, or `BUSY` while occupied. These are internal queue comments, never chat messages, and the card must remain blocked and unassigned.
- Never claim, assign, unblock, start, dispatch, or execute a Sticky Pad card without separate explicit human release. If this MCP is unavailable, do not substitute shell, SSH, direct Kanban commands, or another task system.
- Regular Sticky Pad notes are local-only and never Commander tasks.
<!-- /sticky-pad-quiet-pull:v1 -->
