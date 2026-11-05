# OMP Collab custom web client

This is the browser client source for `maranone/omp-collab`. It is built against the pinned OMP monorepo revision in `.github/workflows/deploy-pages.yml` and deployed as a static GitHub Pages site.

Use `omp config set collab.webUrl https://maranone.github.io/omp-collab` to make OMP generate browser links for this site. The relay is still configured separately by `collab.relayUrl`.

The browser page is public; session data is not published to this repository or Pages. The page connects directly to the OMP relay and the room key remains in the URL fragment.
