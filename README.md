# OMP Collab · maranone

Static, customized OMP Collab browser client, built from the source in [`collab-web/`](collab-web/). The compiled site is in the repository root for GitHub Pages branch publishing.

## Use it

After GitHub Pages finishes deploying, point OMP at this browser UI:

```sh
omp config set collab.webUrl https://maranone.github.io/omp-collab
```

Start a session and use `/collab view` for the read-only link. The relay remains `wss://my.omp.sh`.

## Privacy

This repository and the static app are public. The app does not upload session transcripts to GitHub Pages: the browser connects to OMP's relay, and Collab encrypts session content before sending it. Keep the generated Collab link private; the room key is in its URL fragment and the link grants the access level it was created with. The custom page does not load OMP's analytics script.

## Publishing

GitHub Pages should be set to **Deploy from a branch → `main` → `/(root)`**. The root `index.html` and hashed assets are the compiled site. To rebuild after changing `collab-web/`, use Bun 1.4.4 in the pinned upstream OMP workspace (`96e4d8eb5ba1212d2d6018f242de266284cffab9`), then copy `packages/collab-web/dist/*` to this repository root and commit the generated files.

The source is based on the MIT-licensed [OMP Collab web package](https://github.com/can1357/oh-my-pi/tree/96e4d8eb5ba1212d2d6018f242de266284cffab9/packages/collab-web).
