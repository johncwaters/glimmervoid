---
name: remote-host-setup
description: Stand up a remote Linux host that runs Glimmervoid as a service, reached from the operator's laptop and phone. Use in the Glimmervoid remote setup session.
---

# Remote host setup

You run on the operator's current Glimmervoid machine, outside the guardrails, with their ssh keys. You drive the new host over `ssh`. Every step that must happen on the operator's laptop or phone, or that needs an interactive login, you hand to the operator as an exact command and wait for them to confirm.

The end state:

- Glimmervoid runs on the remote host as a systemd user service that survives logout and reboot.
- The operator reaches its dashboard from the laptop, and from the phone through a paired device link.
- Sessions on the host can sign commits through the operator's forwarded ssh agent.
- Guarded sessions on the host can start their sandbox.

## Ground rules

- Ask before you assume. Start by asking for: the ssh host alias or `user@host`, whether it is a Coder workspace, whether the operator uses Tailscale, and which agent CLIs (Claude Code, Codex) they want on the host.
- Run one remote command per `ssh` call and read its output before the next. Never pipe a downloaded script into a shell without showing the operator the URL first.
- `sudo` on the remote needs the operator's approval every time. Say what it changes and how to revert it.
- Never restart, stop or reinstall a Glimmervoid server from a session that server hosts: the session is a child of the server and dies with it halfway through. This session runs on the operator's current machine, so restarting the NEW host's service is fine; restarting the server this session lives in is not.
- Never copy private keys, tokens or `~/.glimmervoid/config.json` secrets between machines. Secrets go into `~/.glimmervoid/secrets.env` on the host, typed by the operator.
- Never set `GLIMMERVOID_HOST` to a non-loopback address or set `GLIMMERVOID_INSECURE_BIND=1`. Remote access goes through the remote listener and an HTTPS proxy only.

## 1. Reach the host

- Plain host: confirm `ssh <host> true` works without a password prompt. If it does not, hand the operator `ssh-copy-id <host>` to run themselves.
- Coder workspace: the operator runs `coder login <deployment-url>` and `coder config-ssh` on the laptop and on this machine, then the host alias is `coder.<workspace>`. `CODER_SSH_DISABLE_AUTOSTART=true coder ssh <workspace> -- <command>` also works.
- Record the facts you find: `uname -a`, `cat /etc/os-release`, `systemctl --user status` (user systemd must be running), free disk, and memory.

## 2. Prerequisites on the host

- Node.js 22.18.0 or newer (`node --version`). If missing, propose a user-level install (nvm or fnm) rather than a system package, and note the absolute `node` path for the unit file.
- Build tools for `node-pty`: `make`, `g++`, `python3`. On Debian or Ubuntu that is `sudo apt-get install -y build-essential python3`.
- `git`, and `bubblewrap` (the `bwrap` binary) for the guardrails sandbox.
- The agent CLIs the operator chose: `npm install -g @anthropic-ai/claude-code` and or `npm install -g @openai/codex`. Logging in is interactive: hand the operator `ssh -t <host> claude` and `ssh -t <host> codex login` and wait.

### Ubuntu sandbox prerequisite

Ubuntu 23.10 and later set `kernel.apparmor_restrict_unprivileged_userns=1`, which makes `bwrap` fail with `setting up uid map: Permission denied` or `loopback: Failed RTM_NEWADDR`, and guarded sessions never start. Test it:

```bash
bwrap --ro-bind / / --dev /dev --unshare-net true && echo sandbox-ok
```

If it fails, propose the narrow fix, which grants user namespaces to `bwrap` only, and get the operator's approval for the `sudo` steps:

```bash
printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n' | sudo tee /etc/apparmor.d/bwrap
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

Revert by deleting `/etc/apparmor.d/bwrap` and reloading AppArmor. Do not disable the sysctl machine wide.

## 3. Install Glimmervoid

```bash
npm install -g glimmervoid
glimmervoid doctor
```

`glimmervoid doctor` must pass before you go on. If `glimmervoid` is not on `PATH`, check `npm prefix -g`.

## 4. Run it as a service

`glimmervoid.service` beside this file is the unit template. Fill its placeholders on the host:

- `__NODE__`: absolute path of `node` (`command -v node` on the host).
- `__GLIMMERVOID__`: absolute path of the installed `glimmervoid` bin script (`command -v glimmervoid`).
- `__PATH__`: a `PATH` that reaches `node`, `glimmervoid`, `git` and the agent CLIs, built from absolute directories, never `$PATH`.

Write it to `~/.config/systemd/user/glimmervoid.service`, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now glimmervoid
sudo loginctl enable-linger "$USER"
systemctl --user status glimmervoid
journalctl --user -u glimmervoid -n 50
```

`enable-linger` keeps the service alive after the operator logs out; it needs `sudo` on most hosts. The log must show `Open http://localhost:<port>`, the local dashboard listener bound to loopback.

## 5. Reach the dashboard

The local listener has no authentication and stays on loopback. Pick one route with the operator:

- **Laptop over ssh**: `ssh -L 3000:127.0.0.1:3000 <host>` on the laptop, then open `http://localhost:3000`. Simplest, laptop only.
- **Laptop and phone over Tailscale** (the devbox route):
  1. Install Tailscale on the host and join the tailnet: hand the operator `sudo tailscale up` since it prints a login URL.
  2. On the host, edit `~/.glimmervoid/config.json` by hand (`glimmervoid settings` cannot change `remote`), keeping every other key. Set `"remote": { "enabled": true, "port": 3456, "publicHost": "<machine>.<tailnet>.ts.net" }`. `port` must differ from the dashboard port. Optionally add `"ownerLogin": "<their tailscale login>"`.
  3. `systemctl --user restart glimmervoid`, then check the log for `remote listener on http://127.0.0.1:3456 (paired devices only)`.
  4. `tailscale serve --bg 3456`. Use HTTP mode only: `ownerLogin` proves nothing behind `--tcp` or `--tls-terminated-tcp`.
  5. Each device opens `https://<publicHost>/` and sees "Pairing required". On the host, `glimmervoid pair --name <device>` prints a single-use link that expires in 10 minutes. The operator opens it on that device. Treat the link like a password: show it only in this session, never write it to a file.
- **Coder workspace**: Coder proxies the remote listener port as a workspace app; the URL shape is the deployment's own.
  1. On the host, edit `~/.glimmervoid/config.json` by hand (`glimmervoid settings` cannot change `remote`), keeping every other key. Set `"remote": { "enabled": true, "port": 3456, "publicHost": "<coder app hostname for that port>" }`. `port` must differ from the dashboard port. Use `"allowedOrigins": ["https://<coder app hostname>"]` instead of `publicHost` if the operator needs explicit origins. With neither set, dashboard WebSockets from the Coder app origin are rejected.
  2. `systemctl --user restart glimmervoid`, then check the log for `remote listener on http://127.0.0.1:3456 (paired devices only)`.
  3. Pair exactly as in the Tailscale route: open `https://<coder app hostname>/`, then `glimmervoid pair --name <device>` on the host.

## 6. Commit signing

If the operator signs commits with an ssh key held by an agent on the laptop (for example Secretive), no key file belongs on the host. Glimmervoid sessions sign through `glimmervoid ssh-sign`, which signs with the forwarded agent the server finds. That needs a live forwarded connection from the laptop:

- Plain host: `ssh -A <host>` kept open, or `ForwardAgent yes` for that host in the laptop's `~/.ssh/config`.
- Coder: `coder ssh -A <workspace>`; plain `coder ssh` forwards nothing.

Set git on the host to sign with the public key only: `git config --global gpg.format ssh`, `git config --global user.signingkey '<public key line>'`, `git config --global commit.gpgsign true`. "agent refused operation" means the laptop declined or timed out the approval.

## 7. Prove it

Finish only when each of these holds, and show the operator the evidence:

1. `systemctl --user is-active glimmervoid` prints `active`, and `systemctl --user is-enabled glimmervoid` prints `enabled`.
2. `glimmervoid doctor` passes on the host.
3. The operator opened the dashboard through the chosen route and sees it.
4. If Tailscale was set up: a paired device loads the dashboard.
5. If the sandbox check ran: it printed `sandbox-ok`.

Then summarize for the operator: the host, the dashboard URL, which steps they still own (logins, keeping `ssh -A` open for signing), and how to undo each change you made.
