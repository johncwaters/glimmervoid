# Public

The browser dashboard: session cards with xterm terminals, the views and the lane tabs, bundled by Vite

## invariants
- lazy view mounts once: A view registered through load() fetches its chunk at most once, however often it is prefetched or shown, and mounts once, on its first show.
  over: the views public/view-registry.ts registers through load()
  via: a lazy view loads once across prefetch and repeated shows and mounts once, only when shown
  because: a second mount duplicates the panel's DOM and store subscriptions, and a mount before the first show pulls the chunk back onto the cold 3G path
