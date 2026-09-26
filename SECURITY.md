# Security Policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: open the [Security tab of johncwaters/glimmervoid](https://github.com/johncwaters/glimmervoid/security) and choose "Report a vulnerability". Please do not open a public issue or pull request for it.

Include the Glimmervoid version (`glimmervoid --version`), your OS, and the steps or request that reproduce the problem.

## Supported versions

Only the latest release gets security fixes. Update with the command the dashboard's update check shows, or `npm install -g glimmervoid@latest`.

## Trust model

Glimmervoid is a single-user tool that runs coding agents on your machine. Reports are most useful when they break one of these boundaries; behavior these points describe as intended is not a vulnerability.

- **Agents run as you.** Every session is a real terminal process with the server account's privileges. Anything that can drive a session can do anything that account can.
- **Localhost only.** Both listeners bind `127.0.0.1` by default, and any non-loopback bind is refused unless `GLIMMERVOID_INSECURE_BIND=1` is set explicitly.
- **Local processes are trusted, local web pages are not.** There is no login on the local listener by design: any process on the machine can connect. A web page served from another origin is kept out by a Host allow-list, a port-exact Origin check and a per-process page token on the WebSocket upgrades.
- **Hook callbacks are authenticated.** Each session's hook endpoint requires that session's bearer token.
- **Remote access is opt-in and paired.** The `remote` listener is off unless configured, and meant to sit behind a reverse proxy. Devices pair through single-use links that expire after 10 minutes and are never stored in plaintext; a paired device holds a cookie that can be revoked with `glimmervoid pair --revoke <id>`.
- **A pairing URL is a password.** Redeeming one grants full control of the machine as the server account, so never share or log it.

The README's [Limitations](README.md#limitations) section gives the same model in short.
