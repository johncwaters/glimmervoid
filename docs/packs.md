# Packs

A pack is a folder with a `pack.json` that adds themes, panels, launchers, PR flows, agent context and skills, or MCP servers to Glimmervoid. Every field, message and command is in the generated [packs reference](packs-reference.md); this page says why packs work the way they do. `glimmervoid packs guide` gives an agent the same rules.

## Approval follows the files

A pack can run commands on the operator's machine, start agent sessions, and put text in front of every agent. So nothing in a pack runs or shows until the operator approves it in the Packs tab, and the approval is for exact bytes: Glimmervoid hashes every file in the folder into one fingerprint and stores the approved fingerprints, not pack names or versions. Any edit to any file, including a script a command runs or a page a panel loads, makes a new fingerprint that waits for approval again. The `version` field is for people; raising it or not changes nothing about approval.

No tool action, CLI command or panel can approve a pack. An agent installs a pack and calls `request-approval`, which only points the operator at the Packs tab, because an agent that could approve its own pack could grant itself anything a pack grants.

The approval screen shows what each section grants before the operator decides: every launcher prompt word for word, the agent context file, the panel `reads` and `acts`, whether sessions skip permission prompts, and the MCP servers and status URLs. Grants are declared up front so the operator judges what the pack can do, not what its code happens to do today.

## The trust boundary

- **Panels** run in a sandboxed frame with an opaque origin and a fixed Content-Security-Policy: no network, no cookies or storage, no navigation, no access to the dashboard page. A panel sees only the bridge topics listed in its `reads`, and acts as the operator only through the actions its `acts` allows. The pack store is the one place a panel keeps state, capped so a panel cannot fill the disk.
- **Commands** (prFlows) run without a shell, from the Glimmervoid home folder, with Glimmervoid's own secrets stripped from their environment. They print JSON that Glimmervoid parses and caps, so a broken command shows an error on the pull request instead of breaking the view.
- **Sessions** a pack starts follow the pack's `sessions` settings, which the operator approved. A pack whose panels both read reviews and start sessions gets a warning, because text other people wrote could steer what it starts.
- **Agent context and skills** reach sessions as a copy of the approved files, so an unapproved edit never reaches a running agent.
- **MCP secrets** come from the vault, only once the operator allows that secret for the project, and travel by environment variable, never argv.

## What a pack may not do

- Approve itself, or change after approval without asking again.
- Hold symlinks or exceed 1 MiB, so the approved bytes are the bytes that run.
- Reach the network from a panel, or load anything from outside the pack.
- Run anything at install time: install copies files and checks them, nothing more.
- Read the dashboard page, other packs' stores, or Glimmervoid's secrets.

## Pack sources

`glimmervoid packs add <https URL>` clones a team repository of packs with git hooks and symlinks off and only https allowed, so cloning runs no code from the repository. Every pack in it stays off until the operator enables it, which installs it unapproved. `update` pulls and reinstalls the enabled packs; a changed file means a new fingerprint and a new approval. A source never replaces a copy someone else installed since, so a hand-edited pack is not overwritten behind the operator's back.
