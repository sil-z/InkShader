// ESM adapter for the UMD build loaded by index.html.
//
// paper-full.min.js is a UMD/global build: it is loaded synchronously via
// <script src> in index.html and exposes `window.paper`. This module exists so
// every vendored library is consumed the same way (`import paper from
// '../../vendor/paper.js'`) without changing load order or load timing.
//
// See js/vendor/README.md for the file list, versions and upgrade steps.

const paper = globalThis.paper;

export default paper;
