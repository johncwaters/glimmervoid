# Coherence layer

The Coherence layer: runs the repository's own Coherence install for hook status and the session decision journal, and the only code that may run it

## invariants
- coherence boundary: Only server/coherence runs a Coherence CLI or names the .coherence folder, and glimmervoid takes no runtime dependency on a Coherence package.
  over: every source file under server, session, shared, public, bin, detection, notifications and scripts, and package.json
  via: Coherence execution and journal paths stay inside server/coherence with no runtime package dependency
  because: Coherence is an optional layer each repository installs itself; a call or a dependency elsewhere would make it required and tie glimmervoid releases to its version
  kinds: none
