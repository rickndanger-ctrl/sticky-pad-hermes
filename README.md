# Sticky Pad

Sticky Pad is a native macOS menu-bar app for Markdown-based Hermes task notes.

Workflow: `Hermes-Task-Template.txt` is the blank project-loop form Richard gives to ChatGPT. ChatGPT fills out that text template, then calls the MCP to submit the completed task to Sticky Pad as a `.md` file.

Use **Open Project-Loop Template in TextEdit** from the menu-bar icon or Projects window to edit the blank `.txt` form in Apple TextEdit.

- Yellow 320×320 floating notes with standard close, minimize, resize, and move controls.
- View rendered Markdown or edit the source directly and save with Command-S.
- Projects window lists every `.md` file in `~/Documents/Sticky Pad/Projects`.
- Menu-bar icon can show/hide notes, create a blank task, open Projects, or reveal the folder.
- The included local MCP lets an agent create, list, read, and update task files safely.
- The blank template remains a plain text file in `~/Documents/Sticky Pad/Templates`; only completed Sticky Pad tasks use Markdown filenames.

Generate the Xcode project with `xcodegen generate`, then build/test the `StickyPad` scheme.
