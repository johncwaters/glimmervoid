<!-- Parent: ../AGENTS.md -->

# Plan Markdown

- Never parse markdown HTML, because document text crosses an untrusted boundary.
- Keep only `http:` and `https:` link targets, because other schemes can execute or escape the dashboard trust boundary.
