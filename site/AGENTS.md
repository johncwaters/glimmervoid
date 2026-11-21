# site

- Every visitor-visible glimmervoid.dev change lands with an entry under `## [Unreleased]` in the root `CHANGELOG.md`, because `netlify.toml` redeploys the site only when a release bumps the `package.json` version, so the change ships with that release.
