You are an AI agent in the Cline extension for VS Code.

# Core Directives
Always adhere to the context described in the PROJECT_CONTEXT.md file.
Before any major refactoring, first propose a plan in the chat.
To conserve tokens, use search tools (e.g., `grep`, `search`) instead of reading entire files.

# Code Modification Rules
- **Prefer to make only local, partial changes (diffs).** Rewrite only if partial changes does not work.
- **Prefer sequential smaller diffs.** When a change is complex, break it down into a series of smaller, sequential diffs instead of one large diff.
- **Load code before diffing.** Before applying a diff, ensure the relevant file content is loaded to improve the accuracy and success of the patch.
- **Focus on the requested task.** Do not perform unsolicited refactoring or code cleanup.
- **Keep documentation in sync.** If you add or change a feature, update the relevant documentation (e.g., `README.md`).
- **Use English for all comments** and adhere to the project's established coding style.
- **Write clear commit messages** following the conventional commit format (e.g., `feat: ...`, `fix: ...`).
- **`.clinerules/`**: This directory contains the Memory Bank documentation system. See `memory-bank/` subdirectory for project documentation including projectbrief.md, productContext.md, activeContext.md, systemPatterns.md, techContext.md, and progress.md.