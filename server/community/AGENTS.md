# server/community

Community: the opt-in lane that researches new community questions (posthog.com/questions, allowlisted Discord channels) with the operator's skill and drafts a reply for the operator to post.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Community Questions

- Glimmervoid never posts a reply anywhere: the operator copies the draft and posts it, so a wrong answer from a model never reaches the public under the operator's name. The server accepts only re-run and set aside (`CommunityAction` in `shared/contracts/community.ts`); copy, open and start session stay in the browser.
- Question text, Discord messages and drafts are untrusted public data: they reach a prompt only fenced as data (`fencedUntrusted`), and the dashboard renders them as text, never HTML.
- A research run gets open network and no credential, WebSearch but never WebFetch, and its Bash is the read-only `gh search` and `gh issue|pr view` allowlist, because it reads attacker-written text beside PostHog reads; a credential or a page fetch beside open network is an exfiltration path (`node scripts/probe-guardrails-roles.ts --role community`).
- The Discord judge fails closed: no usable answer admits nothing and holds the watermark, so a judge outage delays questions instead of flooding the queue with chatter.
- The Discord watermark moves past every fetched row once the judge answers, not only past admitted items, or rows that make no question pin the oldest-first query forever.
- A Discord author is always shown as a generic member, never a name, so no member identity is copied into Glimmervoid state or a draft.
- Only a finished High confidence run with a draft notifies (browser, and Telegram under the usual off-dashboard gate); every other finish raises tab attention only, so the phone rings for work worth posting.
