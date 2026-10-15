# Security Policy

## Reporting a vulnerability

Report it privately: open the [Security tab](https://github.com/johncwaters/glimmervoid/security) and choose **Report a vulnerability**. Please do not open a public issue or pull request.

Include your Glimmervoid version (`glimmervoid --version`), your OS, and the steps or request that reproduce the problem.

## Supported versions

Only the latest release gets security fixes. Update with the command the dashboard's update banner shows, or `npm install -g glimmervoid@latest`.

## Trust model

Glimmervoid is a single-user tool that runs coding agents on your machine. The most useful reports break one of these boundaries. Behavior described here as intended is not a vulnerability.

- **Agents run as you.** Every session is a real terminal process with the server account's privileges. Anything that can drive a session can do anything that account can.
- **Localhost only.** Both listeners bind `127.0.0.1`. A non-loopback bind is refused unless `GLIMMERVOID_INSECURE_BIND=1` is set.
- **Local processes are trusted, web pages are not.** The local dashboard has no login by design, so any process on the machine can connect. Pages from other origins are kept out by a Host allow-list, a port-exact Origin check and a per-process page token on WebSocket upgrades.
- **Hook callbacks are authenticated.** Each session's hook endpoint requires that session's bearer token.
- **Remote access is opt-in and paired.** The remote listener is off unless configured and is meant to sit behind a reverse proxy. Devices pair through single-use links that expire after 10 minutes and are never stored in plaintext. A paired device's cookie can be revoked with `glimmervoid pair --revoke <id>`.
- **A pairing link is a password.** Redeeming one grants full control of the machine as the server account. Never share or log it.
