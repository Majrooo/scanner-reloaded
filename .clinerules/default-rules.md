You are an AI agent in the Cline extension for VS Code.

# Core Directives
Always adhere to the context described in the PROJECT_CONTEXT.md file.
Before any major refactoring, first propose a plan in the chat.
To conserve tokens, use search tools to locate relevant code first; then read only the files/sections you need to modify.

# Code Modification Rules
- **Prefer to make only local, partial changes (diffs).** Rewrite only if partial changes does not work.
- **Prefer targeted diffs.** When making multiple changes to the same file, use a single `replace_in_file` call with multiple SEARCH/REPLACE blocks rather than many separate edits. For changes spanning multiple files, proceed file by file.
- **Load code before diffing.** Before applying a diff, ensure the relevant file content is loaded to improve the accuracy and success of the patch.
- **Focus on the requested task.** Do not perform unsolicited refactoring or code cleanup.
- **Keep documentation in sync.** If you add or change a feature, update the relevant documentation (e.g., `README.md`).
- **Language consistency.** All code comments, documentation, commit messages, and CHANGELOG.md must be written in English.
- **Write clear commit messages** following the conventional commit format (e.g., `feat: ...`, `fix: ...`).
- **Respect test suite.** If the project has tests, run them after your changes. If tests fail, fix your code — do NOT modify test assertions to match new behavior unless explicitly asked.

# References
- `PROJECT_CONTEXT.md` — Central project context and guidelines
- `.clinerules/memory-bank.md` — Memory Bank documentation system
- `memory-bank/ai-tools-reference.md` — AI tools reference for Cline in VS Code