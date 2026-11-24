# server/community

Community: the opt-in lane that researches new community questions from approved pack sources (`community` in pack.json) with the operator's skill and drafts a reply for the operator to post.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Community Questions

- Glimmervoid never posts a reply anywhere: the operator copies the draft and posts it, so a wrong answer from a model never reaches the public under the operator's name. The server accepts only re-run and set aside (`CommunityAction` in `shared/contracts/community.ts`); copy, open and start session stay in the browser.
- Question text, chat messages and drafts are untrusted public data: an unattended run (research or judge) reads them only from the Glimmervoid-written `untrusted.json` (`server/lanes/untrusted-payload.ts`), never from its prompt; the operator-started session fences them as data (`fencedUntrusted`); the dashboard renders them as text, never HTML.
- A research run reads attacker-written text, so it gets no credential beyond the operator's read token (`LANE_CREDENTIAL_ENV` emptied, Sane YOLO denying credential reads) and its gh and web reach is `laneAccess`, whose proxy env refuses every host off the fetch list; it refuses to start without the read token.
- The question judge (a source with `judge: true`) fails closed: no usable answer admits nothing and holds the watermark, so a judge outage delays questions instead of flooding the queue with chatter.
- A source watermark moves past every fetched item, not only past admitted ones (judged sources once the judge answers), or items that make no question pin the oldest-first query forever.
- A pack source command runs as an approved pack command (`server/packs/pack-command.ts`): scrubbed env, only the keys that name `community-source:<id>`, and secrets masked out of its errors and output. One failing or unconfigured source never stops the others polling.
- The research fetch list grows only by the approved pack's `community.product.docsDomains`, which the approval screen lists, so a pack update that adds a host asks again.
- Only a finished High confidence run with a draft notifies (browser, and Telegram under the usual off-dashboard gate); every other finish raises tab attention only, so the phone rings for work worth posting.
