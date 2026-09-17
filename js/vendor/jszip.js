// ESM adapter for the UMD build loaded by index.html.
//
// jszip.min.js is a UMD/global build: it is loaded synchronously via
// <script src> in index.html and exposes `window.JSZip`. This module exists so
// every vendored library is consumed the same way (`import JSZip from
// '../../vendor/jszip.js'`) without changing load order or load timing.
//
// See js/vendor/README.md for the file list, versions and upgrade steps.

const JSZip = globalThis.JSZip;

export default JSZip;
