# Troubleshooting

Start with `glimmervoid doctor`. It changes nothing and starts no server: it reports versions, where the CLI runs from, whether npm's global bin directory is on PATH, which agent CLIs resolve, whether node-pty loads, and which config file would be used.

## `glimmervoid` is not recognized after a global install

The install worked, but npm's global command directory is not on PATH (common with a zip or standalone Node, a locked-down corporate image, or pnpm without `pnpm setup`).

1. Confirm it installed: `npm ls -g glimmervoid`.
2. Find the directory: `npm config get prefix`. On Windows the `glimmervoid.cmd` and `glimmervoid.ps1` shims live directly in it; on Linux they are in its `bin/`.
3. Add that directory to PATH. The official Node.js Windows installer does this for you. For a zip install on Windows, run this in PowerShell and open a new terminal:

   ```powershell
   [Environment]::SetEnvironmentVariable("PATH", [Environment]::GetEnvironmentVariable("PATH","User") + ";$(npm config get prefix)", "User")
   ```

4. Using pnpm? Run `pnpm setup` once, then reinstall.
5. Run `glimmervoid doctor` to confirm.

## The server refuses to start: node-pty did not load

Glimmervoid checks the node-pty native binding before it boots and refuses to start without it, printing the repair command. The usual cause on Linux is that node-pty was never compiled: it has no Linux prebuilds, and npm 12 blocks dependency install scripts unless told otherwise.

1. Install the build tools: `sudo apt install build-essential python3` (Windows: Visual Studio Build Tools, rarely needed because Windows prebuilds ship).
2. Rebuild node-pty inside the global install:

   ```bash
   npm rebuild -g node-pty --allow-scripts=node-pty
   ```

Two spellings look right and are not:

- Run it from outside the installed package. From inside `$(npm root -g)/glimmervoid` the same command is project-scoped, and npm rejects `--allow-scripts` there with `EALLOWSCRIPTS`.
- Name `node-pty`, not `glimmervoid`. `npm rebuild -g glimmervoid` exits 0 and rebuilds nothing nested.

If that still fails, the in-place form works too, and only node-pty's scripts run because the rebuild is scoped to it:

```bash
cd "$(npm root -g)/glimmervoid" && npm rebuild node-pty --dangerously-allow-all-scripts
```

For a source checkout, run `npm rebuild node-pty --dangerously-allow-all-scripts` from the checkout root.

## `npx npm@12` or npm 12 fails its engine check

npm 12 needs Node 22.22.2, 24.15.0 or 26 and newer. On an older Node, either upgrade Node or install with the npm that ships with it, which runs install scripts by default.

## `EPERM` when retrying a failed install on Windows

A failed attempt can leave a partial `glimmervoid` directory under the global prefix. Remove it, then install again:

```powershell
Remove-Item -Recurse -Force "$(npm root -g)\glimmervoid"
```

## Another Glimmervoid is already running

The server exits with `Another Glimmervoid is already running on port <port>` when the port is taken. Stop the other instance, or start this one with `glimmervoid --port <other>`.

## Refusing to bind a non-loopback host

`GLIMMERVOID_HOST` set to anything but a loopback address is refused, because the local listener has no authentication. Use the `remote` block behind a reverse proxy instead (see the README). `GLIMMERVOID_INSECURE_BIND=1` overrides the refusal and exposes full control of the machine to anyone who can reach the port.

## Legacy install from GitHub

Before the npm registry package, Glimmervoid installed from a git spec (`npm install -g github:johncwaters/glimmervoid --allow-git=root`). Move to the registry package:

```bash
npm uninstall -g glimmervoid
npm install -g glimmervoid
```

(add `--allow-scripts=node-pty` on Linux). If you must stay on the git spec, it needs npm 12: npm 11 global installs from git specs land as a link into a temporary clone that npm then deletes ([npm/cli#9406](https://github.com/npm/cli/issues/9406)). Your `~/.npmrc` must carry no `allow-scripts` line during that install, because npm passes the setting to the child install that prepares the git dependency, which rejects it with `EALLOWSCRIPTS`. Compile node-pty afterwards with the rebuild command above.
