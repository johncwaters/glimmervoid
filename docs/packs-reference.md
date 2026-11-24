# Packs reference

Every field, message and command a pack uses. Generated from the Zod contracts by `npm run docs:packs`, so do not edit it by hand; fix a description at its `.describe()` in `shared/contracts/` and regenerate. Why packs work the way they do: [packs.md](packs.md).

## pack.json

Published as the JSON Schema `https://glimmervoid.dev/schema/pack.v1.json`; point `$schema` at it for editor completion. `glimmervoid packs guide --schema pack` prints the same schema.

### Top level

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `$schema` | string |  |  | Set it to https://glimmervoid.dev/schema/pack.v1.json so an editor completes and checks the file; Glimmervoid ignores it |
| `name` | string, matches `^[a-z0-9][a-z0-9-]{0,39}$` | yes |  | Unique among installed packs; a second pack with the same name is refused. Theme and panel ids are scoped to it, so they never clash with another pack |
| `version` | integer, over 0 | yes |  | Your release number, shown to the operator beside the pack; raise it with each change. Approval follows the files, not this number: any changed file asks again |
| `description` | string, max length 500 |  |  | One or two sentences shown on the pack card in the Packs tab and in the packs guide |
| `preview` | string, matches `^(?!\/)(?!.*(?:^\|\/)\.\.?(?:\/\|$))[A-Za-z0-9._/-]{1,200}$` |  |  | An image of what the pack adds, shown on its card in the Packs tab before it is approved. Glimmervoid releases after 0.58.4 read it; older ones refuse a manifest that sets it |
| `requires` | object |  | `{"env":[],"programs":[]}` | What this machine needs for the pack; while anything is missing the pack stays off here and its card says what, without counting as a problem in the pack |
| `requires.env` | array of string, matches `^[A-Za-z_][A-Za-z0-9_]*$` |  | `[]` | Environment variables the Glimmervoid server must have set |
| `requires.programs` | array of string, matches `^[A-Za-z0-9][A-Za-z0-9._+-]*$` |  | `[]` | Programs that must be on the PATH of the Glimmervoid server, such as gh or node |
| `prFlows` | object |  |  | PR flows this pack adds; one invalid entry skips the whole section See below. |
| `ui` | object |  |  | Themes and panels this pack adds to the dashboard See below. |
| `launchers` | array of objects |  |  | Buttons in the Add session picker, each starting a session with its own prompt See below. |
| `sessions` | object |  |  | Permission settings for every session this pack starts See below. |
| `status` | object |  |  | Status pages its panels read through the providers topic See below. |
| `agent` | object |  |  | Context and skills every session's agent gets once the operator approves the pack See below. |
| `mcp` | object |  |  | MCP servers every session gets once the pack is approved. Glimmervoid releases after 0.62.8 read it; older ones refuse a manifest that sets it See below. |
| `hooks` | array of objects |  |  | Checks every session's agent runs before a tool call once the operator approves the pack, on every first-class agent; one invalid hook skips the whole section. Glimmervoid releases after 0.62.10 read it; older ones refuse a manifest that sets it See below. |
| `settings` | array of objects |  |  | Values the operator fills in the pack Settings once the pack is approved, plain text or vault secrets, each reaching pack commands as an environment variable. Glimmervoid releases after 0.64.0 read it; older ones refuse a manifest that sets it See below. |
| `jobs` | array of objects |  |  | Commands run on a schedule once the pack is approved, each saving the JSON it prints in the pack store for its panels. Glimmervoid releases after 0.64.0 read it; older ones refuse a manifest that sets it See below. |
| `community` | object |  |  | Question sources the Community tab polls once the pack is approved, and what the questions are about. Glimmervoid releases after 0.64.0 read it; older ones refuse a manifest that sets it See below. |

### `prFlows`

PR flows this pack adds; one invalid entry skips the whole section

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `prFlows.repos` | array of string, matches `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`, min items 1 |  |  | The default owner/name repositories, matched case-insensitively, for every prAction, source and rule of this pack that lists no repos of its own; an entry's own repos narrow this default to the repositories both list; every repository when absent |
| `prFlows.prActions` | array of objects |  | `[]` | Buttons on a pull request; the command prints {"outcome":"done\|started\|refused\|failed","message":"..."}, and one that prints started reports later with glimmervoid pr-action report |
| `prFlows.prActions[].id` | string, matches `^[a-z0-9][a-z0-9-]{0,63}$` | yes |  | Unique within its list; inside a pack it is shown as <pack>/<id> |
| `prFlows.prActions[].label` | string, min length 1, max length 24 | yes |  | The name shown to the operator; rules never match on it |
| `prFlows.prActions[].command` | array of string, min length 1, min items 1 | yes |  | The program and its arguments, run without a shell from the Glimmervoid home folder; an argument may hold {prUrl}, {repo}, {number}, {head}, {headRef}, {baseRef}, and in a pack also {packDir}, the pack's folder. Its environment has GLIMMERVOID_PR_URL, GLIMMERVOID_PR_REPO, GLIMMERVOID_PR_NUMBER and GLIMMERVOID_PR_HEAD, GLIMMERVOID_PR_HEAD_REF, GLIMMERVOID_PR_BASE_REF and the pull request as GLIMMERVOID_PR_JSON. Exit 0 means done and any other exit failed, unless stdout prints the action outcome JSON (glimmervoid packs guide --schema pr-flows) |
| `prFlows.prActions[].timeoutSeconds` | integer, max 3600, over 0 |  | `120` | Seconds before the command is stopped |
| `prFlows.prActions[].repos` | array of string, matches `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`, min items 1 |  |  | The owner/name repositories this applies to; every repository when absent |
| `prFlows.sources` | array of objects |  | `[]` | Commands run on each pull request that print {"findings":[{"path","lineStart","lineEnd","priority","body","url"}],"status":[{"label","state"}]}, at most 200 findings and 4 status lines |
| `prFlows.sources[].id` | string, matches `^[a-z0-9][a-z0-9-]{0,63}$` | yes |  | Unique within its list; inside a pack it is shown as <pack>/<id> |
| `prFlows.sources[].label` | string, min length 1, max length 24 | yes |  | The name shown to the operator; rules never match on it |
| `prFlows.sources[].command` | array of string, min length 1, min items 1 | yes |  | The program and its arguments, run without a shell from the Glimmervoid home folder; an argument may hold {prUrl}, {repo}, {number}, {head}, and in a pack also {packDir}, the pack's folder. Its environment has GLIMMERVOID_PR_URL, GLIMMERVOID_PR_REPO, GLIMMERVOID_PR_NUMBER and GLIMMERVOID_PR_HEAD. It must print the source output JSON (glimmervoid packs guide --schema pr-flows) on stdout; anything else shows as an error on the pull request |
| `prFlows.sources[].timeoutSeconds` | integer, max 3600, over 0 |  | `120` | Seconds before the command is stopped |
| `prFlows.sources[].repos` | array of string, matches `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`, min items 1 |  |  | The owner/name repositories this applies to; every repository when absent |
| `prFlows.actions` | array of objects |  | `[]` | Commands rules run on one review item with run:<id>; they print {"outcome":"done\|started\|refused\|failed","message":"..."} and are limited to repositories only through the rules that name them |
| `prFlows.actions[].id` | string, matches `^[a-z0-9][a-z0-9-]{0,63}$` | yes |  | Unique within its list; inside a pack it is shown as <pack>/<id> |
| `prFlows.actions[].label` | string, min length 1, max length 24 | yes |  | The name shown to the operator; rules never match on it |
| `prFlows.actions[].command` | array of string, min length 1, min items 1 | yes |  | The program and its arguments, run without a shell from the Glimmervoid home folder; an argument may hold {prUrl}, {repo}, {number}, {head}, {itemPath}, {itemLine}, and in a pack also {packDir}, the pack's folder. Its environment has GLIMMERVOID_PR_URL, GLIMMERVOID_PR_REPO, GLIMMERVOID_PR_NUMBER and GLIMMERVOID_PR_HEAD, and the review item as GLIMMERVOID_ITEM_JSON. Exit 0 means done and any other exit failed, unless stdout prints the action outcome JSON (glimmervoid packs guide --schema pr-flows) |
| `prFlows.actions[].timeoutSeconds` | integer, max 3600, over 0 |  | `120` | Seconds before the command is stopped |
| `prFlows.rules` | array of objects |  | `[]` | Run after your own config.json rules; the first rule that matches an item decides it |
| `prFlows.rules[].name` | string, min length 1, max length 80, matches `\S` | yes |  | Shown in the Handled list beside each item the rule decided |
| `prFlows.rules[].sources` | array of string, matches `^[a-z0-9][a-z0-9-]{0,63}$`, min items 1 |  |  | The bare ids of this pack's sources the rule acts on. An item merged from several sources matches only when every one of them is listed here or under authors; any source when both are absent |
| `prFlows.rules[].authors` | array of string, min length 1, min items 1 |  |  | The GitHub logins of review comment authors this rule acts on, compared case-insensitively. An item merged from several sources matches only when every one of them is listed here or under authors; any source when both are absent |
| `prFlows.rules[].priority` | array of one of `"blocker"`, `"high"`, `"medium"`, `"low"`, `"unknown"`, min items 1 |  |  | The finding priorities this rule acts on; any priority when absent |
| `prFlows.rules[].paths` | array of string, min length 1, min items 1 |  |  | Repository paths; an entry ending in / matches every path under it, any other matches that exact path |
| `prFlows.rules[].text` | string, min length 1 |  |  | Text the finding must contain, compared case-insensitively |
| `prFlows.rules[].scope` | one of `"mine"`, `"team"`, `"both"` |  | `"mine"` | Rules act only on your own pull requests today, so mine and both act there and team never acts yet |
| `prFlows.rules[].repos` | array of string, matches `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`, min items 1 |  |  | The owner/name repositories this applies to; every repository when absent |
| `prFlows.rules[].action` | one of `"ask"`, `"fix-local"`, `"dismiss"` or string, matches `^run:[a-z0-9][a-z0-9-]{0,63}$` | yes |  | ask waits for you, fix-local hands the item to a local session, dismiss replies with reason and resolves it, run:<id> runs that action; run:<id> names an action of this pack by its bare id |
| `prFlows.rules[].reason` | string, min length 1, max length 2000 |  |  | The reply posted when the rule dismisses an item |

### `ui`

Themes and panels this pack adds to the dashboard

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `ui.themes` | array of objects, max items 8 |  | `[]` | Color themes added to the Theme picker |
| `ui.themes[].label` | string, min length 1, max length 40 | yes |  | The name shown in the Theme picker |
| `ui.themes[].mode` | one of `"dark"`, `"light"` | yes |  | Whether the theme is dark or light, which picks the terminal palette its ANSI colors are tuned for |
| `ui.themes[].accentAnsiSlot` | one of `"blue"`, `"magenta"`, `"none"` | yes |  | The terminal ANSI color the accent replaces, with a lighter mix of it as that color's bright variant; none leaves terminal colors alone |
| `ui.themes[].chrome` | object | yes |  | Dashboard colors; each key becomes the CSS custom property --<key> |
| `ui.themes[].chrome.bg` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Page background |
| `ui.themes[].chrome.bg-card` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Cards, panes and the terminal background |
| `ui.themes[].chrome.bg-header` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Headers and toolbars |
| `ui.themes[].chrome.bg-surface` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Raised controls: chips, inputs, menus and hover fills |
| `ui.themes[].chrome.border` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Default borders |
| `ui.themes[].chrome.border-dim` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Faint dividers inside a card or list |
| `ui.themes[].chrome.border-hover` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Borders of a hovered or focused control |
| `ui.themes[].chrome.text` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Body text |
| `ui.themes[].chrome.text-dim` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Secondary text such as hints and empty states |
| `ui.themes[].chrome.text-head` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Headings and emphasized text |
| `ui.themes[].chrome.text-muted` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Labels and metadata, between text and text-dim |
| `ui.themes[].chrome.accent` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | Links, focus rings, selection and primary actions |
| `ui.themes[].chrome.accent-dim` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | A quieter accent for selected borders |
| `ui.themes[].states` | object | yes |  | One color per session state, shown as --state-<state> on cards, dots and badges |
| `ui.themes[].states.running` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | The color of a running session, as --state-running |
| `ui.themes[].states.waiting` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | The color of a waiting session, as --state-waiting |
| `ui.themes[].states.failed` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | The color of a failed session, as --state-failed |
| `ui.themes[].states.monitoring` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | The color of a monitoring session, as --state-monitoring |
| `ui.themes[].states.done` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | The color of a done session, as --state-done |
| `ui.themes[].states.initializing` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | The color of a initializing session, as --state-initializing |
| `ui.themes[].states.idle` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | The color of a idle session, as --state-idle |
| `ui.themes[].states.starting` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | The color of a starting session, as --state-starting |
| `ui.themes[].states.complete` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  | The color of a complete session, as --state-complete |
| `ui.themes[].id` | string, matches `^[a-z0-9][a-z0-9-]{0,39}$` | yes |  | Unique within its list in this pack, and scoped to the pack name so it never clashes with another pack |
| `ui.panels` | array of objects, max items 8 |  | `[]` | HTML pages shown as dashboard tabs, each sandboxed with no network and talking to the dashboard only through the panel bridge |
| `ui.panels[].id` | string, matches `^[a-z0-9][a-z0-9-]{0,39}$` | yes |  | Unique within its list in this pack, and scoped to the pack name so it never clashes with another pack |
| `ui.panels[].label` | string, min length 1, max length 24 | yes |  | The tab name of the panel in the dashboard |
| `ui.panels[].entry` | string, matches `^(?!\/)(?!.*(?:^\|\/)\.\.?(?:\/\|$))[A-Za-z0-9._/-]{1,200}$` | yes |  | The HTML page the panel opens, relative to the pack folder |
| `ui.panels[].icon` | string, matches `^(?!\/)(?!.*(?:^\|\/)\.\.?(?:\/\|$))[A-Za-z0-9._/-]{1,200}$` |  |  | An .svg file in the pack shown beside the panel label |
| `ui.panels[].reads` | array of one of `"sessions"`, `"focus"`, `"theme"`, `"usage"`, `"attention"`, `"reviews"`, `"providers"` |  | `[]` | The bridge topics this panel may receive; the operator sees them before approving, and a subscribe for any other topic is ignored |
| `ui.panels[].acts` | array of one of `"reviews"`, `"sessions"` |  | `[]` | What this panel may do as the operator, without asking again: reviews lets it post, discard or requeue team reviews and resolve their threads, open an agent session on a pull request, merge your pull requests, turn merge when ready on or off, turn keep mergeable on or off, dismiss review items, hand them to a session or run their actions, reopen handled review items, save rules to your config, approve PR flow commands, run PR actions; sessions lets it start an agent session with any prompt in any project, and type text into any live session on this machine, using the pack sessions settings; the operator sees it before approving |

### `launchers`

Buttons in the Add session picker, each starting a session with its own prompt

A list, max items 16, of:

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `launchers[].id` | string, matches `^[a-z0-9][a-z0-9-]{0,39}$` | yes |  | Unique within its list in this pack, and scoped to the pack name so it never clashes with another pack |
| `launchers[].label` | string, matches `^[A-Za-z0-9_\-. ()]{1,24}$` | yes |  | The button text, also the name of the session it starts |
| `launchers[].project` | string, max length 4096, matches `^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\|\/.+\|[A-Za-z]:[\\/].*)$` | yes |  | owner/name: the first configured project whose origin is that GitHub repository; or an absolute path of a folder on this machine. A launcher whose project matches nothing shows disabled |
| `launchers[].agent` | one of `"claude-code"`, `"codex"`, `"kimi"`, `"opencode"`, `"pi"`, `"antigravity"` | yes |  | The agent the session runs |
| `launchers[].model` | string, max length 200, matches `^[A-Za-z0-9._:/[\]-]+$` |  |  | The model passed to the agent, as its own --model flag takes it; absent uses the agent default |
| `launchers[].effort` | string, max length 40, matches `^[A-Za-z0-9._:/[\]-]+$` |  |  | The reasoning effort passed to the agent, such as low, medium or high; absent uses the agent default |
| `launchers[].prompt` | string, min length 1, max length 4000, matches `^[\P{C}\n\t]*$` | yes |  | The first prompt the session gets |
| `launchers[].schedule` | string, max length 100 |  |  | A cron pattern of five fields in the operator timezone; the launcher also starts its session on this schedule, skipping a run while its last scheduled session is still live, and catching up runs missed while Glimmervoid was down only with catchUp |
| `launchers[].catchUp` | boolean |  |  | With a schedule, start one run at once when a scheduled run fell while Glimmervoid was down or the host slept; off skips missed runs |

### `sessions`

Permission settings for every session this pack starts

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `sessions.dangerouslySkipPermissions` | boolean |  | `false` | Sessions this pack starts skip the agent's permission prompts; the operator sees it before approving |
| `sessions.saneYolo` | boolean |  |  | With dangerouslySkipPermissions, also catch risky commands with Sane YOLO; absent follows the operator's default |

### `status`

Status pages its panels read through the providers topic

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `status.urls` | array of string, max length 2048, URL, max items 8 | yes |  | Statuspage summary URLs, such as https://www.githubstatus.com/api/v2/summary.json; the providers topic carries their open incidents |

### `agent`

Context and skills every session's agent gets once the operator approves the pack

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `agent.context` | string, matches `^(?!\/)(?!.*(?:^\|\/)\.\.?(?:\/\|$))[A-Za-z0-9._/-]{1,200}$` |  |  | A file in the pack that every session's first prompt names, so the agent reads it when the task touches what it covers; the operator reads it word for word before approving |
| `agent.skills` | array of string, matches `^(?!\/)(?!.*(?:^\|\/)\.\.?(?:\/\|$))[A-Za-z0-9._/-]{1,200}$`, max items 32 |  | `[]` | Skill folders in the pack, each holding a SKILL.md; every session gets them, as /<pack>:<folder name> on Claude Code and <pack>-<folder name> on Codex and Kimi Code |

### `mcp`

MCP servers every session gets once the pack is approved. Glimmervoid releases after 0.62.8 read it; older ones refuse a manifest that sets it

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mcp.servers` | array of objects, min items 1, max items 8 | yes |  | MCP servers every locally launched glimmervoid session gets once the operator approves the pack |
| `mcp.servers[].name` | string, matches `^[a-z0-9][a-z0-9_-]{0,39}$` | yes |  | The name every agent lists the server under; a server the operator registered under the same name gives way to this one in glimmervoid sessions |
| `mcp.servers[].url` | string, matches `^(https://\|http://(127\.0\.0\.1\|localhost\|\[::1\])([:/?#]\|$))[^${}]*$`, URL | yes |  | The streamable HTTP MCP endpoint; with no secret the agent signs in through its own MCP OAuth login |
| `mcp.servers[].secret` | string, matches `^[A-Z_][A-Z0-9_]{0,127}$` |  |  | A bearer token sent to this server: glimmervoid reads the name from the vault at session start once the operator allows it for the project, and passes it by environment variable, never argv; while it is denied or cannot be read, a Gemini CLI or Kimi Code session fails its sign-in and any other session leaves the server out |

### `hooks`

Checks every session's agent runs before a tool call once the operator approves the pack, on every first-class agent; one invalid hook skips the whole section. Glimmervoid releases after 0.62.10 read it; older ones refuse a manifest that sets it

A list, min items 1, max items 16, of:

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `hooks[].id` | string, matches `^[a-z0-9][a-z0-9-]{0,39}$` | yes |  | Unique within its list in this pack, and scoped to the pack name so it never clashes with another pack |
| `hooks[].description` | string, min length 1, max length 300 | yes |  | What the hook checks, shown to the operator before approving |
| `hooks[].event` | `"beforeTool"` | yes |  | beforeTool runs the hook before each tool call of a kind it watches, in every agent |
| `hooks[].tools` | array of one of `"edit"`, `"shell"`, min items 1, max items 2 |  | `["edit","shell"]` | The tool kinds the hook watches |
| `hooks[].command` | array of string, min length 1, max length 1000, min items 1, max items 32 | yes |  | The program and its arguments, run without a shell in the session folder; an argument after the program may hold {packDir}, the folder of the approved pack copy the session reads, whose files are not executable. It reads one JSON object on stdin: {"version":1,"event":"beforeTool","agent":"claude\|codex\|kimi\|antigravity\|opencode\|pi","sessionId","cwd","tool":{"kind":"edit\|shell\|other","name","command","filePaths","input"}}. Exit 2 blocks the tool call, and the agent reads stderr as the reason; any other exit, a crash or a timeout lets the call run |
| `hooks[].timeoutSeconds` | integer, min 1, max 60 |  | `10` | A hook still running after this many seconds is stopped and the call runs |

### `settings`

Values the operator fills in the pack Settings once the pack is approved, plain text or vault secrets, each reaching pack commands as an environment variable. Glimmervoid releases after 0.64.0 read it; older ones refuse a manifest that sets it

A list, min items 1, max items 16, of:

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `settings[].key` | string, max length 64, matches `^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$` | yes |  | The environment variable the value reaches the pack commands under; a secret is kept in the vault as GLIMMERVOID_PACK_<PACK>__<KEY>, so it never meets another pack's or a session's secret |
| `settings[].label` | string, min length 1, max length 60 | yes |  | The field name shown to the operator in the pack Settings |
| `settings[].kind` | one of `"text"`, `"secret"` |  | `"text"` | text: a plain value saved in Glimmervoid's pack settings file and passed to the commands listed in commands, or to every command of the pack when none is listed; secret: a value kept in the vault and passed only to the commands listed in commands |
| `settings[].hint` | string, max length 200 |  |  | One line under the field, such as where to find the value |
| `settings[].commands` | array of string, matches `^(pr-source\|pr-item-action\|pr-action\|job\|community-source):[a-z0-9][a-z0-9-]{0,39}$`, max items 32 |  | `[]` | The pack commands that receive the value, each as <kind>:<id>, listed to the operator before approving; a secret no command lists reaches no command, a text value no command lists reaches every command, and a command waits only for the values that reach it |

### `jobs`

Commands run on a schedule once the pack is approved, each saving the JSON it prints in the pack store for its panels. Glimmervoid releases after 0.64.0 read it; older ones refuse a manifest that sets it

A list, min items 1, max items 8, of:

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `jobs[].id` | string, matches `^[a-z0-9][a-z0-9-]{0,39}$` | yes |  | Unique within its list in this pack, and scoped to the pack name so it never clashes with another pack |
| `jobs[].label` | string, min length 1, max length 40 | yes |  | The name shown to the operator before approving and in a failure warning |
| `jobs[].schedule` | string, max length 100 | yes |  | A cron pattern of five fields in the operator timezone; a run still going when the next one comes due skips that one, and runs never hold up other launchers or jobs |
| `jobs[].catchUp` | boolean |  |  | Run once at once when a scheduled run fell while Glimmervoid was down or the host slept; off skips missed runs |
| `jobs[].command` | array of string, min length 1, max length 1000, min items 1, max items 32 | yes |  | The program and its arguments, run without a shell from the Glimmervoid home folder; an argument may hold {packDir}, the pack's folder. Its environment has the pack settings and the secrets that list job:<id>. It prints one JSON value on stdout, which Glimmervoid saves in the pack store under the key job:<id>, where the pack's panels read it and which panels cannot write |
| `jobs[].timeoutSeconds` | integer, min 1, max 600 |  | `60` | Seconds before the run is stopped and counts as failed |

### `community`

Question sources the Community tab polls once the pack is approved, and what the questions are about. Glimmervoid releases after 0.64.0 read it; older ones refuse a manifest that sets it

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `community.product` | object | yes |  |  |
| `community.product.name` | string, min length 1, max length 60 | yes |  | What the questions are about; the judge and the research prompt name it |
| `community.product.docsDomains` | array of string, matches `^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$`, max items 8 |  | `[]` | Hosts a research run may fetch pages from besides GitHub, listed to the operator before approving |
| `community.sources` | array of objects, min items 1, max items 8 | yes |  |  |
| `community.sources[].id` | string, matches `^[a-z0-9][a-z0-9-]{0,39}$` | yes |  | Unique within its list in this pack, and scoped to the pack name so it never clashes with another pack |
| `community.sources[].label` | string, min length 1, max length 40 | yes |  | The source name the Community tab shows beside each question, such as Example forum |
| `community.sources[].icon` | string | yes |  | An .svg file in the pack, drawn as a one-color mark in the source color |
| `community.sources[].color` | object | yes |  | The mark color on dark and on light themes |
| `community.sources[].color.dark` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  |  |
| `community.sources[].color.light` | string, matches `^#[0-9a-fA-F]{6}$` | yes |  |  |
| `community.sources[].command` | array of string, min length 1, max length 1000, min items 1, max items 32 | yes |  | The program and its arguments, run without a shell from the Glimmervoid home folder on every Community poll; an argument may hold {packDir}. Its environment has GLIMMERVOID_SINCE, the time of the newest question it already gave, the pack settings and the secrets that list community-source:<id>. It prints {"items":[{"id","title","body","url","author","channel","tags","createdAt","resolved"}]} on stdout, at most 200 items. Glimmervoid cuts a title to 300 characters, a body to 20000, an author to 100 and tags to 20, and skips an item it cannot read without stopping the rest; printing an item it gave before updates its title and resolved |
| `community.sources[].timeoutSeconds` | integer, min 1, max 300 |  | `60` | Seconds before a poll is stopped and counts as failed |
| `community.sources[].judge` | boolean |  | `false` | Run the question judge on new items first, for a chat source where most messages are not questions |

## Panel bridge

Messages a panel and the dashboard exchange with `postMessage`. `glimmervoid packs guide --schema bridge` prints them as JSON Schema.

### Panel to dashboard

#### `subscribe`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"subscribe"` | yes |  |  |
| `topics` | array of one of `"sessions"`, `"focus"`, `"theme"`, `"usage"`, `"attention"`, `"reviews"`, `"providers"` | yes |  | The topics to receive; only those also listed in the panel's reads in pack.json are granted, and a later subscribe replaces the earlier one. An empty list still gets hello and the store |

#### `action`

Send one action as the operator would: a Reviews action needs reviews under the panel acts, a session action needs sessions; the host answers with action-result

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"action"` | yes |  |  |
| `id` | string, min length 1, max length 64 | yes |  | Any id the panel picks; the matching action-result carries it back |
| `request` | object | yes |  | One action, checked against the same schema the server uses before it is sent |
| `request.type` | one of `"team-review-action"`, `"open-team-review-session"`, `"my-pr-merge"`, `"my-pr-merge-when-ready"`, `"my-pr-keep-mergeable"`, `"pr-flow-dispose"`, `"pr-flow-undo"`, `"pr-flow-save-rule"`, `"pr-flow-approve"`, `"pr-action-run"`, `"pack-session-start"`, `"pack-session-send"` | yes |  | A Reviews control message type, or pack-session-start or pack-session-send; the other fields are that message's own, without requestId, pack and panelId, which the host fills in |

#### `store-set`

Save one key of the pack store; the host answers with a store message

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"store-set"` | yes |  |  |
| `key` | string, min length 1, max length 128 | yes |  | Any key the pack picks; job:<id> keys hold job output, which panels read but cannot write |
| `value` | any JSON value | yes |  | Any JSON value nested at most 32 levels deep; null deletes the key |

#### `log`

Write one line to the Glimmervoid server log as [dashboard] pack: <name>/<panel>; packs preview shows it instead. At most 30 lines a minute per panel reach the log

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"log"` | yes |  |  |
| `level` | one of `"info"`, `"warn"`, `"error"` | yes |  | The log level the line is written at |
| `text` | string, min length 1, max length 500 | yes |  | At most 500 characters |

### Dashboard to panel

#### `hello`

The answer to each subscribe

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"hello"` | yes |  |  |
| `granted` | array of one of `"sessions"`, `"focus"`, `"theme"`, `"usage"`, `"attention"`, `"reviews"`, `"providers"` | yes |  | The subscribed topics that are also in reads; a topic missing here never arrives |

#### `store`

Sent after hello and after each store-set from any panel of the pack in this dashboard

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"store"` | yes |  |  |
| `data` | object | yes |  | The pack's saved keys and values, shared by all its panels and kept across reloads, browsers and pack updates; at most 65536 bytes as JSON, deleted when the pack folder is removed |
| `error` | string, or null | yes |  | Why the last store-set was not saved, such as the size limit; null when it was |

#### `action-result`

The answer to one action message

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"action-result"` | yes |  |  |
| `id` | string, min length 1, max length 64 | yes |  | Any id the panel picks; the matching action-result carries it back |
| `ok` | boolean | yes |  | True only when the server ran the action; false when the panel lacks acts, the request is invalid or too large, the server is unreachable or did not answer in time, or the server reply says ok false |
| `timedOut` | boolean | yes |  | True when no reply came in time: the action may still run, so check the reviews topic before sending it again |
| `result` | object, or null | yes |  | The server reply, such as a team-review-action-result, whenever one arrived |
| `error` | string, or null | yes |  | Why ok is false; null when it is true |

#### `topic`: `sessions`

Sent right after hello and again whenever the data changes, checked once a second

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"topic"` | yes |  |  |
| `topic` | `"sessions"` | yes |  |  |
| `data` | object | yes |  |  |
| `data.sessions` | array of objects | yes |  |  |
| `data.sessions[].id` | string | yes |  | The stable session id, the id pack-session-send takes |
| `data.sessions[].name` | string | yes |  | The session name shown on its card |
| `data.sessions[].agent` | string, or null | yes |  | The agent id, such as claude-code; null when unknown |
| `data.sessions[].state` | string | yes |  | One of DORMANT, INITIALIZING, STARTING, RUNNING, WAITING, IDLE, COMPLETE, DONE, FAILED; the theme color for a state is --state-<state in lowercase>, and DORMANT has none |
| `data.sessions[].stateSinceMs` | number | yes |  | When the session entered its state, as Unix epoch milliseconds |
| `data.sessions[].taskTitle` | string, or null | yes |  | The short title of what the session is working on; null until one is set |

#### `topic`: `focus`

Sent right after hello and again whenever the data changes, checked once a second

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"topic"` | yes |  |  |
| `topic` | `"focus"` | yes |  |  |
| `data` | object | yes |  |  |
| `data.sessionId` | string, or null | yes |  | The session in focus; null when none is |
| `data.view` | string | yes |  | The dashboard view open now, such as focus, prs or usage |

#### `topic`: `theme`

Sent right after hello and again whenever the data changes, checked once a second

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"topic"` | yes |  |  |
| `topic` | `"theme"` | yes |  |  |
| `data` | object | yes |  |  |
| `data.id` | string, or null | yes |  | The active theme's id; a pack theme's id is <pack name>/<theme id> |
| `data.colors` | object | yes |  | CSS custom properties to set on the root element, keyed with their leading --: one per theme chrome key (--bg, --bg-card, --bg-header, --bg-surface, --border, --border-dim, --border-hover, --text, --text-dim, --text-head, --text-muted, --accent, --accent-dim) and per session state (--state-<state>, a hex color, and --state-<state>-bg, a translucent color-mix tint of it) |

#### `topic`: `usage`

Sent right after hello and again whenever the data changes, checked once a second

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"topic"` | yes |  |  |
| `topic` | `"usage"` | yes |  |  |
| `data` | object | yes |  |  |
| `data.planLimits` | array of objects | yes |  | One entry per agent that has reported plan limits; an agent that has not is absent |
| `data.planLimits[].vendor` | one of `"claude"`, `"codex"`, `"kimi"` | yes |  |  |
| `data.planLimits[].fiveHour` | object, or null | yes |  | null when the agent reported nothing for this window |
| `data.planLimits[].fiveHour.pct` | number, or null | yes |  | Percent of the window used, 0 to 100; 100 or more means the limit is reached; null when the agent did not report it |
| `data.planLimits[].fiveHour.resetsAtMs` | number, or null | yes |  | When the window resets, as Unix epoch milliseconds; null when the agent did not report it |
| `data.planLimits[].sevenDay` | object, or null | yes |  | null when the agent reported nothing for this window |
| `data.planLimits[].sevenDay.pct` | number, or null | yes |  | Percent of the window used, 0 to 100; 100 or more means the limit is reached; null when the agent did not report it |
| `data.planLimits[].sevenDay.resetsAtMs` | number, or null | yes |  | When the window resets, as Unix epoch milliseconds; null when the agent did not report it |

#### `topic`: `attention`

Sent right after hello and again whenever the data changes, checked once a second

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"topic"` | yes |  |  |
| `topic` | `"attention"` | yes |  |  |
| `data` | object | yes |  |  |
| `data.waiting` | number | yes |  | Sessions waiting on the operator |
| `data.finished` | number | yes |  | Sessions that finished with an outcome the operator has not seen |
| `data.failed` | number | yes |  | Sessions that failed |

#### `topic`: `reviews`

Sent right after hello and again whenever the data changes, checked once a second

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"topic"` | yes |  |  |
| `topic` | `"reviews"` | yes |  |  |
| `data` | object | yes |  |  |
| `data.groups` | array of objects | yes |  | The Reviews tab queue in list order: your turn, agent working, queued, waiting on others, merged, parked |
| `data.groups[].id` | one of `"turn"`, `"working"`, `"queued"`, `"waiting"`, `"merged"`, `"parked"` | yes |  |  |
| `data.groups[].title` | string | yes |  |  |
| `data.groups[].items` | array of the objects below | yes |  |  |
| `data.groups[].items[] (source "team").key` | string | yes |  |  |
| `data.groups[].items[] (source "team").prKey` | string | yes |  | The pull request key, owner/repo#number in lowercase |
| `data.groups[].items[] (source "team").action` | one of `"fix"`, `"review"`, `"reply"`, `"update"`, `"merge"`, or null | yes |  | What the operator does next on this item; null when nothing is theirs to do |
| `data.groups[].items[] (source "team").attention` | one of `"waiting"`, `"finished"`, `"failed"`, or null | yes |  |  |
| `data.groups[].items[] (source "team").source` | `"team"` | yes |  | A teammate's pull request the review lane reviews |
| `data.groups[].items[] (source "team").kind` | one of `"ready"`, `"inReview"`, `"queued"`, `"attention"`, `"posted"`, `"discarded"` | yes |  |  |
| `data.groups[].items[] (source "team").review` | one of the objects below | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).requestSource` | one of `"direct"`, `"team"` |  | `"team"` |  |
| `data.groups[].items[] (source "team").review (shape 1).isDraft` | boolean |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).checksState` | one of `"SUCCESS"`, `"FAILURE"`, `"PENDING"`, `"ERROR"`, `"EXPECTED"`, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).isAuthorOrgMember` | boolean, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).key` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).repo` | string, matches `^[^/]+\/[^/]+$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).number` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).title` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).url` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).author` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).tier` | one of `"stamp"`, `"full"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).reasons` | array of string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).reviewedHead` | string, matches `^[0-9a-f]{40}$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).reviewedBase` | string, matches `^[0-9a-f]{40}$` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).verdict` | one of `"APPROVE"`, `"APPROVE WITH NITS"`, `"REQUEST CHANGES"`, `"BLOCKED"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).summary` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).assessment` | object |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).assessment.goal` | string |  | `""` |  |
| `data.groups[].items[] (source "team").review (shape 1).assessment.change` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).assessment.checked` | array of string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).assessment.gaps` | array of string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).assessment.handChecks` | array of objects |  | `[]` |  |
| `data.groups[].items[] (source "team").review (shape 1).assessment.handChecks[].text` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).assessment.handChecks[].paths` | array of string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).assessment.handChecks[].isFallback` | boolean |  | `false` |  |
| `data.groups[].items[] (source "team").review (shape 1).body` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).comments` | array of objects | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).comments[].path` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).comments[].line` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).comments[].side` | one of `"RIGHT"`, `"LEFT"` |  | `"RIGHT"` |  |
| `data.groups[].items[] (source "team").review (shape 1).comments[].body` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).comments[].severity` | one of `"CRITICAL"`, `"HIGH"`, `"MEDIUM"`, `"LOW"` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).comments[].excerpt` | array of objects, max items 9 |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).comments[].excerpt[].line` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).comments[].excerpt[].kind` | one of `"add"`, `"del"`, `"context"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).comments[].excerpt[].text` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).comments[].flaggedBy` | array of string, min length 1 |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).status` | one of `"ready"`, `"stale"`, `"posted"`, `"discarded"`, `"error"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).error` | string |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads` | array of objects |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].id` | string, min length 1, max length 256, matches `^[A-Za-z0-9_=-]+$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].path` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].line` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].isResolved` | boolean | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].viewerCanResolve` | boolean | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].isNit` | boolean | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].url` | string, URL | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].viewerComment` | string, max length 1500 |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].lastReplyBody` | string, max length 1500 |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].viewerCommentTruncated` | boolean |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].lastReplyTruncated` | boolean |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].lastReplyAuthor` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].lastReplyAt` | string, matches `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].judgement` | object |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].judgement.addressed` | boolean | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].judgement.reason` | string, min length 1, max length 4000 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].judgement.head` | string, matches `^[0-9a-f]{40}$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].judgement.judgedAt` | number | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].judgement.lastReplyAt` | string, matches `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].resolveError` | string |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].resolveAttemptReplyAt` | string |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].judgeAttempt` | object |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].judgeAttempt.head` | string, matches `^[0-9a-f]{40}$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].judgeAttempt.lastReplyAt` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].judgeAttempt.retryAt` | number | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].unjudgeable` | object |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].unjudgeable.head` | string, matches `^[0-9a-f]{40}$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].unjudgeable.lastReplyAt` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).threads[].unjudgeable.reason` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems` | array of objects |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].key` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].path` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].lineStart` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].lineEnd` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].priority` | one of `"blocker"`, `"high"`, `"medium"`, `"low"`, `"unknown"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].sources` | array of objects, min items 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].sources[].kind` | one of `"own"`, `"thread"`, `"configured"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].sources[].name` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].sources[].sourceId` | string, min length 1 |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].sources[].threadId` | string |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].sources[].url` | string, URL, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].sources[].priority` | one of `"blocker"`, `"high"`, `"medium"`, `"low"`, `"unknown"` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].sources[].excerpt` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].sources[].dismissalKey` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].excerpt` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).otherReviewItems[].url` | string, URL, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems` | array of objects |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].key` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].path` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].lineStart` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].lineEnd` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].priority` | one of `"blocker"`, `"high"`, `"medium"`, `"low"`, `"unknown"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].sources` | array of objects, min items 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].sources[].kind` | one of `"own"`, `"thread"`, `"configured"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].sources[].name` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].sources[].sourceId` | string, min length 1 |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].sources[].threadId` | string |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].sources[].url` | string, URL, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].sources[].priority` | one of `"blocker"`, `"high"`, `"medium"`, `"low"`, `"unknown"` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].sources[].excerpt` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].sources[].dismissalKey` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].excerpt` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).resolvedOtherReviewItems[].url` | string, URL, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).viewerThreads` | object |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).viewerThreads.total` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).viewerThreads.resolved` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviews` | array of objects |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviews[].login` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviews[].state` | one of `"APPROVED"`, `"CHANGES_REQUESTED"`, `"COMMENTED"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviews[].commit` | string, matches `^[0-9a-f]{40}$`, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviews[].isViewer` | boolean | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviews[].submittedAt` | string, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviewHistory` | array of objects |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviewHistory[].login` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviewHistory[].state` | one of `"APPROVED"`, `"CHANGES_REQUESTED"`, `"COMMENTED"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviewHistory[].commit` | string, matches `^[0-9a-f]{40}$`, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviewHistory[].isViewer` | boolean | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).githubReviewHistory[].submittedAt` | string, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).reviewDecision` | one of `"APPROVED"`, `"CHANGES_REQUESTED"`, `"REVIEW_REQUIRED"`, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).liveHead` | string, matches `^[0-9a-f]{40}$` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).prCreatedAt` | string |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).reviewedAt` | number |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).postedAt` | number |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).postedEvent` | one of `"APPROVE"`, `"COMMENT"`, `"REQUEST_CHANGES"` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).priorReviewedHead` | string, matches `^[0-9a-f]{40}$` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).requeuedHead` | string, matches `^[0-9a-f]{40}$` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview` | object |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.head` | string, matches `^[0-9a-f]{40}$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.verdict` | one of `"APPROVE"`, `"APPROVE WITH NITS"`, `"REQUEST CHANGES"`, `"BLOCKED"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.summary` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.wasPosted` | boolean | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.body` | string |  | `""` |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments` | array of objects | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments[].path` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments[].line` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments[].side` | one of `"RIGHT"`, `"LEFT"` |  | `"RIGHT"` |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments[].body` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments[].severity` | one of `"CRITICAL"`, `"HIGH"`, `"MEDIUM"`, `"LOW"` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments[].excerpt` | array of objects, max items 9 |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments[].excerpt[].line` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments[].excerpt[].kind` | one of `"add"`, `"del"`, `"context"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments[].excerpt[].text` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).earlierReview.comments[].flaggedBy` | array of string, min length 1 |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted` | object |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.body` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments` | array of objects | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments[].path` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments[].line` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments[].side` | one of `"RIGHT"`, `"LEFT"` |  | `"RIGHT"` |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments[].body` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments[].severity` | one of `"CRITICAL"`, `"HIGH"`, `"MEDIUM"`, `"LOW"` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments[].excerpt` | array of objects, max items 9 |  |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments[].excerpt[].line` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments[].excerpt[].kind` | one of `"add"`, `"del"`, `"context"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments[].excerpt[].text` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 1).drafted.comments[].flaggedBy` | array of string, min length 1 |  |  |  |
| `data.groups[].items[] (source "team").review (shape 2).requestSource` | one of `"direct"`, `"team"` |  | `"team"` |  |
| `data.groups[].items[] (source "team").review (shape 2).isDraft` | boolean |  |  |  |
| `data.groups[].items[] (source "team").review (shape 2).checksState` | one of `"SUCCESS"`, `"FAILURE"`, `"PENDING"`, `"ERROR"`, `"EXPECTED"`, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 2).isAuthorOrgMember` | boolean, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 2).reviewDecision` | one of `"APPROVED"`, `"CHANGES_REQUESTED"`, `"REVIEW_REQUIRED"`, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 2).key` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).repo` | string, matches `^[^/]+\/[^/]+$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).number` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).title` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).url` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).author` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).tier` | one of `"stamp"`, `"full"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).reasons` | array of string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).head` | string, matches `^[0-9a-f]{40}$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).phase` | one of `"preparing"`, `"checkout"`, `"reviewing"` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).startedAt` | number | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).deadlineAt` | number, or null | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).toolCalls` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).recentSteps` | array of objects | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).recentSteps[].at` | number | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).recentSteps[].tool` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).recentSteps[].detail` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 2).prCreatedAt` | string |  |  |  |
| `data.groups[].items[] (source "team").review (shape 2).priorReviewedHead` | string, matches `^[0-9a-f]{40}$` |  |  |  |
| `data.groups[].items[] (source "team").review (shape 3).requestSource` | one of `"direct"`, `"team"` |  | `"team"` |  |
| `data.groups[].items[] (source "team").review (shape 3).isDraft` | boolean |  |  |  |
| `data.groups[].items[] (source "team").review (shape 3).checksState` | one of `"SUCCESS"`, `"FAILURE"`, `"PENDING"`, `"ERROR"`, `"EXPECTED"`, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 3).isAuthorOrgMember` | boolean, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 3).reviewDecision` | one of `"APPROVED"`, `"CHANGES_REQUESTED"`, `"REVIEW_REQUIRED"`, or null |  |  |  |
| `data.groups[].items[] (source "team").review (shape 3).key` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 3).repo` | string, matches `^[^/]+\/[^/]+$` | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 3).number` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 3).title` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 3).url` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 3).author` | string | yes |  |  |
| `data.groups[].items[] (source "team").review (shape 3).prCreatedAt` | string |  |  |  |
| `data.groups[].items[] (source "mine").key` | string | yes |  |  |
| `data.groups[].items[] (source "mine").prKey` | string | yes |  | The pull request key, owner/repo#number in lowercase |
| `data.groups[].items[] (source "mine").action` | one of `"fix"`, `"review"`, `"reply"`, `"update"`, `"merge"`, or null | yes |  | What the operator does next on this item; null when nothing is theirs to do |
| `data.groups[].items[] (source "mine").attention` | one of `"waiting"`, `"finished"`, `"failed"`, or null | yes |  |  |
| `data.groups[].items[] (source "mine").source` | `"mine"` | yes |  | One of the operator's own pull requests |
| `data.groups[].items[] (source "mine").pr` | object | yes |  |  |
| `data.groups[].items[] (source "mine").pr.key` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.repo` | string, matches `^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.number` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.title` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.url` | string, URL | yes |  |  |
| `data.groups[].items[] (source "mine").pr.isDraft` | boolean | yes |  |  |
| `data.groups[].items[] (source "mine").pr.state` | one of `"OPEN"`, `"MERGED"`, `"CLOSED"` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.createdAt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.mergedAt` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.updatedAt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.baseRefName` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.baseRefOid` | string, matches `^[0-9a-f]{40}$` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.headRefName` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.isCrossRepository` | boolean | yes |  |  |
| `data.groups[].items[] (source "mine").pr.headRefOid` | string, matches `^[0-9a-f]{40}$` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.isInMergeQueue` | boolean | yes |  |  |
| `data.groups[].items[] (source "mine").pr.mergeMethod` | one of `"MERGE"`, `"SQUASH"`, `"REBASE"` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.mergeable` | one of `"MERGEABLE"`, `"CONFLICTING"`, `"UNKNOWN"` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.mergeStateStatus` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewDecision` | one of `"APPROVED"`, `"CHANGES_REQUESTED"`, `"REVIEW_REQUIRED"`, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.checks` | object | yes |  |  |
| `data.groups[].items[] (source "mine").pr.checks.state` | one of `"SUCCESS"`, `"FAILURE"`, `"PENDING"`, `"ERROR"`, `"EXPECTED"`, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.checks.failing` | array of string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.checks.pendingCount` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.unresolvedThreads` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads` | array of objects | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads[].id` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads[].path` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads[].line` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads[].isOutdated` | boolean | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads[].url` | string, URL | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads[].author` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads[].excerpt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads[].commentCount` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads[].lastAuthor` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.threads[].lastActivityAt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems` | array of objects | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].key` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].path` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].lineStart` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].lineEnd` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].priority` | one of `"blocker"`, `"high"`, `"medium"`, `"low"`, `"unknown"` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].sources` | array of objects, min items 1 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].sources[].kind` | one of `"own"`, `"thread"`, `"configured"` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].sources[].name` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].sources[].sourceId` | string, min length 1 |  |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].sources[].threadId` | string |  |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].sources[].url` | string, URL, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].sources[].priority` | one of `"blocker"`, `"high"`, `"medium"`, `"low"`, `"unknown"` |  |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].sources[].excerpt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].sources[].dismissalKey` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].excerpt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewItems[].url` | string, URL, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.behindBy` | integer, min 0, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewRequests` | array of objects | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewRequests[].name` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewRequests[].isTeam` | boolean | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviewRequests[].avatarUrl` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.approvals` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviews` | array of objects | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviews[].reviewer` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviews[].state` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.reviews[].submittedAt` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").pr.stage` | one of `"merged"`, `"draft"`, `"conflicts"`, `"behind"`, `"checks-failing"`, `"changes-requested"`, `"unresolved-threads"`, `"checks-pending"`, `"needs-approval"`, `"ready"`, `"unknown"` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.autoRebase` | object |  |  |  |
| `data.groups[].items[] (source "mine").pr.autoRebase.outcome` | one of `"rebased"`, `"failed"` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.autoRebase.at` | number | yes |  |  |
| `data.groups[].items[] (source "mine").pr.autoRebase.message` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.keepMergeable` | boolean |  |  |  |
| `data.groups[].items[] (source "mine").pr.keepMergeableAttempt` | object |  |  |  |
| `data.groups[].items[] (source "mine").pr.keepMergeableAttempt.outcome` | one of `"pushed"`, `"no-change"`, `"failed"`, `"stopped"`, `"timed-out"` | yes |  |  |
| `data.groups[].items[] (source "mine").pr.keepMergeableAttempt.reason` | string, min length 1 |  |  |  |
| `data.groups[].items[] (source "mine").pr.keepMergeableAttempt.at` | number | yes |  |  |
| `data.groups[].items[] (source "mine").pr.isKeepMergeableFixInFlight` | boolean |  |  |  |
| `data.groups[].items[] (source "mine").pr.mergeQueuePosition` | integer, over 0, or null |  |  |  |
| `data.groups[].items[] (source "mine").pr.isMergeQueueHeldForRepairPush` | boolean |  |  |  |
| `data.groups[].items[] (source "mine").pr.mergeQueueFailure` | object |  |  |  |
| `data.groups[].items[] (source "mine").pr.mergeQueueFailure.at` | number | yes |  |  |
| `data.groups[].items[] (source "mine").pr.mergeQueueFailure.message` | string | yes |  |  |
| `data.groups[].items[] (source "mine").pr.stageSinceMs` | number |  |  |  |
| `data.groups[].items[] (source "mine").pr.additions` | integer, min 0 |  |  |  |
| `data.groups[].items[] (source "mine").pr.deletions` | integer, min 0 |  |  |  |
| `data.groups[].items[] (source "mine").stackRow` | object | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr` | object | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.key` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.repo` | string, matches `^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.number` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.title` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.url` | string, URL | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.isDraft` | boolean | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.state` | one of `"OPEN"`, `"MERGED"`, `"CLOSED"` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.createdAt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.mergedAt` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.updatedAt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.baseRefName` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.baseRefOid` | string, matches `^[0-9a-f]{40}$` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.headRefName` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.isCrossRepository` | boolean | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.headRefOid` | string, matches `^[0-9a-f]{40}$` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.isInMergeQueue` | boolean | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.mergeMethod` | one of `"MERGE"`, `"SQUASH"`, `"REBASE"` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.mergeable` | one of `"MERGEABLE"`, `"CONFLICTING"`, `"UNKNOWN"` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.mergeStateStatus` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewDecision` | one of `"APPROVED"`, `"CHANGES_REQUESTED"`, `"REVIEW_REQUIRED"`, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.checks` | object | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.checks.state` | one of `"SUCCESS"`, `"FAILURE"`, `"PENDING"`, `"ERROR"`, `"EXPECTED"`, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.checks.failing` | array of string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.checks.pendingCount` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.unresolvedThreads` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads` | array of objects | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads[].id` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads[].path` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads[].line` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads[].isOutdated` | boolean | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads[].url` | string, URL | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads[].author` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads[].excerpt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads[].commentCount` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads[].lastAuthor` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.threads[].lastActivityAt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems` | array of objects | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].key` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].path` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].lineStart` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].lineEnd` | integer, over 0, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].priority` | one of `"blocker"`, `"high"`, `"medium"`, `"low"`, `"unknown"` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].sources` | array of objects, min items 1 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].sources[].kind` | one of `"own"`, `"thread"`, `"configured"` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].sources[].name` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].sources[].sourceId` | string, min length 1 |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].sources[].threadId` | string |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].sources[].url` | string, URL, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].sources[].priority` | one of `"blocker"`, `"high"`, `"medium"`, `"low"`, `"unknown"` |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].sources[].excerpt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].sources[].dismissalKey` | string, min length 1 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].excerpt` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewItems[].url` | string, URL, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.behindBy` | integer, min 0, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewRequests` | array of objects | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewRequests[].name` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewRequests[].isTeam` | boolean | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviewRequests[].avatarUrl` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.approvals` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviews` | array of objects | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviews[].reviewer` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviews[].state` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.reviews[].submittedAt` | string, or null | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.stage` | one of `"merged"`, `"draft"`, `"conflicts"`, `"behind"`, `"checks-failing"`, `"changes-requested"`, `"unresolved-threads"`, `"checks-pending"`, `"needs-approval"`, `"ready"`, `"unknown"` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.autoRebase` | object |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.autoRebase.outcome` | one of `"rebased"`, `"failed"` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.autoRebase.at` | number | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.autoRebase.message` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.keepMergeable` | boolean |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.keepMergeableAttempt` | object |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.keepMergeableAttempt.outcome` | one of `"pushed"`, `"no-change"`, `"failed"`, `"stopped"`, `"timed-out"` | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.keepMergeableAttempt.reason` | string, min length 1 |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.keepMergeableAttempt.at` | number | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.isKeepMergeableFixInFlight` | boolean |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.mergeQueuePosition` | integer, over 0, or null |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.isMergeQueueHeldForRepairPush` | boolean |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.mergeQueueFailure` | object |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.mergeQueueFailure.at` | number | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.mergeQueueFailure.message` | string | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.stageSinceMs` | number |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.additions` | integer, min 0 |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.pr.deletions` | integer, min 0 |  |  |  |
| `data.groups[].items[] (source "mine").stackRow.parentKey` | string, or null | yes |  | The key of the pull request this one is stacked on; null at the bottom of a stack |
| `data.groups[].items[] (source "mine").stackRow.depth` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.stackSize` | integer, over 0 | yes |  |  |
| `data.groups[].items[] (source "mine").stackRow.stackHeight` | integer, min 0 | yes |  |  |
| `data.groups[].items[] (source "mine").mergeBlocker` | string, or null | yes |  | Why Glimmervoid would refuse to merge it now, the same check the server runs before a merge; null when a merge is allowed |

#### `topic`: `providers`

Sent right after hello and again whenever the data changes, checked once a second

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `v` | `1` | yes |  | The bridge protocol version; a message with any other v is ignored |
| `kind` | `"topic"` | yes |  |  |
| `topic` | `"providers"` | yes |  |  |
| `data` | object | yes |  |  |
| `data.providers` | array of objects | yes |  | One entry per URL in the pack's status.urls, in that order |
| `data.providers[].url` | string | yes |  | A statuspage summary URL the pack lists under status.urls |
| `data.providers[].name` | string, or null | yes |  | The status page's own name, such as GitHub; null until a read succeeds |
| `data.providers[].incidents` | array of objects | yes |  | Open incidents, newest first; resolved ones are left out |
| `data.providers[].incidents[].name` | string, max length 300 | yes |  |  |
| `data.providers[].incidents[].status` | one of `"investigating"`, `"identified"`, `"monitoring"`, `"scheduled"`, `"in_progress"`, `"verifying"`, `"other"` | yes |  | The statuspage incident status; other when the page reports a state this list lacks |
| `data.providers[].incidents[].impact` | string, max length 40, or null | yes |  | none, minor, major or critical, as the page reports it |
| `data.providers[].incidents[].updatedAtMs` | number | yes |  | When the incident was last updated, as Unix epoch milliseconds |
| `data.providers[].incidents[].url` | string, or null | yes |  | The https link to the incident page |
| `data.providers[].checkedAtMs` | number, or null | yes |  | When Glimmervoid last read the page, as Unix epoch milliseconds; pages are read at most once every five minutes |
| `data.providers[].error` | string, or null | yes |  | Why the last read failed; incidents is then empty |

## Panel actions

The `request` of an `action` message, by `request.type`. Review actions need `reviews` under the panel `acts`; session actions need `sessions`. `glimmervoid packs guide --schema actions` prints them as JSON Schema.

### `open-team-review-session`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"open-team-review-session"` | yes |  |  |
| `key` | string | yes |  |  |

### `team-review-action`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"team-review-action"` | yes |  |  |
| `key` | string, min length 1 | yes |  |  |
| `head` | string, matches `^[0-9a-f]{40}$` |  |  |  |
| `action` | one of `"approve"`, `"approve-only"`, `"comment"`, `"request-changes"`, `"discard"`, `"requeue"`, `"restore"`, `"resolve-thread"` | yes |  |  |
| `threadId` | string, min length 1, max length 256, matches `^[A-Za-z0-9_=-]+$` |  |  |  |
| `body` | string | yes |  |  |
| `comments` | array of objects | yes |  |  |
| `comments[].path` | string | yes |  |  |
| `comments[].line` | integer, over 0 | yes |  |  |
| `comments[].side` | one of `"RIGHT"`, `"LEFT"` |  | `"RIGHT"` |  |
| `comments[].body` | string | yes |  |  |

### `my-pr-merge`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"my-pr-merge"` | yes |  |  |
| `repo` | string, matches `^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$` | yes |  |  |
| `number` | integer, over 0 | yes |  |  |
| `headRefOid` | string, matches `^[0-9a-f]{40}$` | yes |  |  |

### `my-pr-keep-mergeable`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"my-pr-keep-mergeable"` | yes |  |  |
| `repo` | string, matches `^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$` | yes |  |  |
| `number` | integer, over 0 | yes |  |  |
| `keepMergeable` | boolean | yes |  |  |

### `my-pr-merge-when-ready`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"my-pr-merge-when-ready"` | yes |  |  |
| `repo` | string, matches `^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$` | yes |  |  |
| `number` | integer, over 0 | yes |  |  |
| `mergeWhenReady` | boolean | yes |  |  |

### `pr-flow-dispose`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"pr-flow-dispose"` | yes |  |  |
| `prKey` | string, min length 1 | yes |  |  |
| `itemKey` | string, min length 1 | yes |  |  |
| `action` | one of `"dismiss"`, `"fix-local"` or string, matches `^run:(?:[a-z0-9][a-z0-9-]{0,39}\/)?[a-z0-9][a-z0-9-]{0,63}$` | yes |  |  |
| `reason` | string, min length 1, max length 2000 |  |  |  |

### `pr-flow-undo`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"pr-flow-undo"` | yes |  |  |
| `prKey` | string, min length 1 | yes |  |  |
| `itemKey` | string, min length 1 | yes |  |  |

### `pr-flow-save-rule`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"pr-flow-save-rule"` | yes |  |  |
| `prKey` | string, min length 1 | yes |  |  |
| `itemKey` | string, min length 1 | yes |  |  |
| `reason` | string, min length 1, max length 2000 | yes |  |  |

### `pr-flow-approve`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"pr-flow-approve"` | yes |  |  |
| `fingerprint` | string, min length 1, max length 128 | yes |  |  |

### `pr-action-run`

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"pr-action-run"` | yes |  |  |
| `repo` | string, matches `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$` | yes |  |  |
| `number` | integer, over 0 | yes |  |  |
| `actionId` | string, matches `^(?:[a-z0-9][a-z0-9-]{0,39}\/)?[a-z0-9][a-z0-9-]{0,63}$` | yes |  |  |
| `head` | string, min length 1, max length 64 | yes |  |  |

### `pack-session-start`

Start a session from a panel that lists sessions under acts; the reply is add-session-result

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"pack-session-start"` | yes |  |  |
| `project` | string, max length 4096, matches `^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\|\/.+\|[A-Za-z]:[\\/].*)$` | yes |  | owner/name: the first configured project whose origin is that GitHub repository; or an absolute path of a folder on this machine |
| `agent` | one of `"claude-code"`, `"codex"`, `"kimi"`, `"opencode"`, `"pi"`, `"antigravity"` | yes |  | The agent the session runs |
| `model` | string, max length 200, matches `^[A-Za-z0-9._:/[\]-]+$` |  |  | The model passed to the agent, as its own --model flag takes it; absent uses the agent default |
| `effort` | string, max length 40, matches `^[A-Za-z0-9._:/[\]-]+$` |  |  | The reasoning effort passed to the agent, such as low, medium or high; absent uses the agent default |
| `prompt` | string, min length 1, max length 4000, matches `^[\P{C}\n\t]*$` | yes |  | The first prompt the session gets |
| `name` | string, matches `^[A-Za-z0-9_\-. ()]{1,24}$` |  |  | The session name; absent uses the panel label |

### `pack-session-send`

Type text into a live session from a panel that lists sessions under acts; the reply is pack-session-send-result

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `type` | `"pack-session-send"` | yes |  |  |
| `id` | string | yes |  | The live session to type into, from the sessions topic |
| `text` | string, min length 1, max length 4000 | yes |  | Typed into the session and submitted |

## prFlows command output

Each prFlows command prints one JSON object on stdout. `glimmervoid packs guide --schema pr-flows` prints these as JSON Schema.

### What a source command prints

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `findings` | array of objects, max items 200 | yes |  | Review items this source raises on the pull request |
| `findings[].path` | string, min length 1, max length 500, matches `^[^\u0000-\u001f\u007f-\u009f]+$` | yes |  | The repository path the finding is about |
| `findings[].lineStart` | integer, over 0, or null | yes |  | The first line it is about; null for the whole file |
| `findings[].lineEnd` | integer, over 0, or null | yes |  | The last line it is about; null for the whole file |
| `findings[].priority` | one of `"blocker"`, `"high"`, `"medium"`, `"low"`, `"unknown"` | yes |  | How much it matters; rules match on it |
| `findings[].body` | string, min length 1, max length 4000 | yes |  | The finding text, shown on the review item |
| `findings[].url` | string, URL, or null |  | `null` | A link to more detail; null for none |
| `status` | array of objects, max items 4 |  | `[]` | Short status lines shown on the pull request |
| `status[].label` | string, min length 1, max length 24, matches `^[^\u0000-\u001f\u007f-\u009f]+$` | yes |  | What the line is about, shown before the state |
| `status[].state` | string, min length 1, max length 80, matches `^[^\u0000-\u001f\u007f-\u009f]+$` | yes |  | Its current value, shown on the pull request as <label>: <state> |

### What a prAction or action command prints

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `outcome` | one of `"done"`, `"started"`, `"refused"`, `"failed"` | yes |  | started means the run goes on and reports its final outcome later with glimmervoid pr-action report |
| `message` | string, max length 200 |  | `""` | Shown after the outcome beside the button |

## The `glimmervoid packs` command

Build a Glimmervoid pack: read the guide, check, preview and install a pack folder, ask the operator to approve it, list and remove installed packs, add and update shared pack sources.

| Command | What it does |
|---|---|
| `glimmervoid packs guide` | How to build a pack: its rules, the workflow and example packs to copy; --schema prints a JSON Schema. `--schema <pack\|bridge\|actions\|pr-flows>`: Print only the pack.json (pack), panel bridge (bridge), panel action request (actions) or prFlows command output (pr-flows) JSON Schema |
| `glimmervoid packs check <folder>` | Check a pack folder as Glimmervoid loads it, and every file its pages load; exits 1 on any problem. `--json`: Machine-readable output |
| `glimmervoid packs preview <folder>` | Serve a pack folder's panels on 127.0.0.1 with sample data and its themes, re-reading the pack on every page load, until Ctrl-C. `--port <number>`: Port to serve on (default: any free port) |
| `glimmervoid packs list` | The packs the running Glimmervoid found and whether each is approved; works inside a Glimmervoid session |
| `glimmervoid packs install <folder>` | Check a pack folder and copy it into the packs folder, where it waits for the operator to approve it; installing again replaces the copy; works inside a Glimmervoid session |
| `glimmervoid packs status <name>` | One pack's approval state, load errors and anything missing on this machine; works inside a Glimmervoid session |
| `glimmervoid packs request-approval <name>` | Ask the operator to approve an installed pack in the Packs tab; works inside a Glimmervoid session |
| `glimmervoid packs remove <name>` | Delete a pack that install placed; a pack placed by hand stays; works inside a Glimmervoid session |
| `glimmervoid packs add <https-git-url>` | Clone a git repository of shared packs as a pack source; each pack stays off until the operator enables it in the Packs tab; works inside a Glimmervoid session |
| `glimmervoid packs update [https-git-url]` | Pull every pack source, or the one given, and reinstall its enabled packs, which wait for approval again when changed; works inside a Glimmervoid session |

## Worked example

The `pack.json` of [`examples/packs/pr-radar/`](../examples/packs/pr-radar/). The example-packs gate runs `glimmervoid packs check` on every folder in `examples/packs`, so this example always loads.

```json
{
  "$schema": "https://glimmervoid.dev/schema/pack.v1.json",
  "name": "pr-radar",
  "version": 1,
  "preview": "preview.webp",
  "description": "A panel of the Reviews queue, your pull requests and the team reviews waiting on you, that opens a review session for a team pull request, plus a My PRs action that prints a review checklist from a script in the pack.",
  "requires": { "programs": ["node"] },
  "ui": {
    "panels": [
      { "id": "radar", "label": "PR radar", "entry": "panel/index.html", "icon": "icon.svg", "reads": ["reviews", "theme"], "acts": ["reviews"] }
    ]
  },
  "prFlows": {
    "prActions": [
      { "id": "checklist", "label": "Review checklist", "command": ["node", "{packDir}/review-checklist.mjs", "{prUrl}", "{headRef}", "{baseRef}"], "timeoutSeconds": 30 }
    ]
  }
}
```

The other examples, by the sections they use:

- [`executor`](../examples/packs/executor/): `requires`, `mcp`
- [`night-shift`](../examples/packs/night-shift/): `ui`
- [`plan-usage`](../examples/packs/plan-usage/): `ui`
- [`posthog-community`](../examples/packs/posthog-community/): `requires`, `settings`, `community`
- [`pr-table`](../examples/packs/pr-table/): `ui`
- [`session-board`](../examples/packs/session-board/): `ui`
- [`ship`](../examples/packs/ship/): `requires`, `agent`, `hooks`
