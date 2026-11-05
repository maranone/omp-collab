# OMP Collab · maranone

Personal GitHub Pages build of the OMP Collab browser client. It keeps the regular OMP relay and adds a persistent, expanded TODO board, the Titanium dark palette, expanded thinking blocks, and a scrolling current-task footer.

## Use it

After GitHub Pages finishes deploying, point OMP at this browser UI:

```sh
omp config set collab.webUrl https://maranone.github.io/omp-collab
```

Start a session and use `/collab view` for the read-only link. The relay remains `wss://my.omp.sh`.

## Privacy

This repository and the static app are public. The app does not upload session transcripts to GitHub Pages: the browser connects to OMP's relay, and Collab encrypts session content before sending it. Keep the generated Collab link private; the room key is in its URL fragment and the link grants the access level it was created with. The custom page does not load OMP's analytics script.

## Deployment

The GitHub Actions workflow overlays this package onto the pinned upstream OMP source, builds its static `dist/` site with Bun, and deploys that artifact to GitHub Pages on pushes to `main`. In the repository's **Settings → Pages**, set the publishing source to **GitHub Actions**.

The checked-in app source is under [`collab-web/`](collab-web/). It is based on the MIT-licensed [OMP Collab web package](https://github.com/can1357/oh-my-pi/tree/main/packages/collab-web).
