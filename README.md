# OMP Collab · maranone

Static, customized OMP Collab browser client, built from the source in [`collab-web/`](collab-web/). The compiled site is in the repository root for GitHub Pages branch publishing.

## Use it

After GitHub Pages finishes deploying, point OMP at this browser UI:

```sh
omp config set collab.webUrl https://maranone.github.io/omp-collab
```

Start a session and use `/collab view` for the read-only link. The relay remains `wss://my.omp.sh`.

## Voice narration

`collab-web/` adds an optional spoken monitor of the live session. It observes the frames the page already receives (a read-only frame observer inside `GuestClient`); nothing is added to OMP or to the relay, and upstream behaviour is untouched.

- Narration speaks the session's own text as it is — assistant messages, user messages, tool output. Only events the protocol does not carry in words get short fixed wording: `Reading notes.txt`, `Command finished. output, 44 lines; first errors: …`, `Subagent started scout.`, `OMP started context compaction.`, `Connection lost. Reconnecting.`
- Long tool payloads, JSON dumps, fenced code, ANSI and markdown are shortened for speech; the full recorded content stays in the session registry and is reachable through **Read in detail**.
- Controls: **Enable voice** plus a settings panel in the header, and a compact HUD above the composer — pause/resume, skip, read last again, read history, clear queue, verbosity, rate, voice, read user messages, read visible reasoning.
- The queue is FIFO and nothing is dropped when events arrive faster than speech; the pending count and approximate delay are shown. Compaction and subagent activity are narrated in order while the backlog drains.
- Arming needs one click (browser autoplay policy). Once armed, new events narrate automatically; reconnecting never re-recites the transcript, only the number of events recovered during the gap.
- If the browser has no `speechSynthesis`, the monitor reports **No speech in this browser** and still records events.

## Privacy

This repository and the static app are public. The app does not upload session transcripts to GitHub Pages: the browser connects to OMP's relay, and Collab encrypts session content before sending it. Keep the generated Collab link private; the room key is in its URL fragment and the link grants the access level it was created with. The custom page does not load OMP's analytics script.

Voice narration keeps its event registry in memory only. **Save history in this browser** is opt-in (off by default) and stores settled records in IndexedDB under a session-scoped key, expiring after 72 h; **Clear history** removes them. Room credentials and Collab links are never used as storage keys or values.

## Publishing

GitHub Pages should be set to **Deploy from a branch → `main` → `/(root)`**. The root `index.html` and hashed assets are the compiled site.

Rebuild from a checkout of the pinned upstream OMP workspace (`96e4d8eb5ba1212d2d6018f242de266284cffab9`) with Bun 1.4.4 — the monorepo is required because the client resolves `@oh-my-pi/*` through the workspace catalog. Copy `collab-web/src` and `collab-web/test` over `packages/collab-web/`, then in `packages/collab-web`:

```sh
bun install                                # once; bun.lock regenerates if the catalog drifted
bun run gen:export-viewer --write          # after component changes; writes packages/coding-agent/export-assets
bun test voice                           # 93 voice tests
bun x tsc --noEmit -p tsconfig.json      # not `bun run check:types`: it recurses into `check` on Bun 1.4.4
bun x oxlint src test
bun build ./index.html --outdir=dist --minify --define 'process.env.NODE_ENV="production"' \
  --entry-naming=[hash].[ext] --chunk-naming=[hash].[ext] --asset-naming=[hash].[ext]
mv dist/*.html dist/index.html && cp -R public/. dist/
```

`bun run build` is the same chain, but it fails on Windows (`refusing to pass argument with cmd.exe special characters to a batch file`), so call `bun build` directly there. Asset names are content hashes: copy `packages/collab-web/dist/*` into this repository root, remove the root files whose hashes no longer appear in `index.html`, and commit the generated files.

The source is based on the MIT-licensed [OMP Collab web package](https://github.com/can1357/oh-my-pi/tree/96e4d8eb5ba1212d2d6018f242de266284cffab9/packages/collab-web).
