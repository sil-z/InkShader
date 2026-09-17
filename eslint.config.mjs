// ESLint flat config — the frontend is zero-build native ESM, so this only performs
// static checks; it never takes part in a build.
//
//   npm run lint        check
//   npm run lint:fix    apply auto-fixable fixes
//
// The rule set is deliberately conservative: this repository had no static analysis
// before, and enabling the full recommended set at once would drown 44k lines of
// existing code in warnings unrelated to real defects. Only "almost certainly a real
// error" rules are enabled here; the rest can be adopted incrementally.

const BROWSER_GLOBALS = {
    window: 'readonly',
    document: 'readonly',
    console: 'readonly',
    localStorage: 'readonly',
    sessionStorage: 'readonly',
    indexedDB: 'readonly',
    fetch: 'readonly',
    navigator: 'readonly',
    location: 'readonly',
    history: 'readonly',
    performance: 'readonly',
    requestAnimationFrame: 'readonly',
    cancelAnimationFrame: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    queueMicrotask: 'readonly',
    ResizeObserver: 'readonly',
    MutationObserver: 'readonly',
    IntersectionObserver: 'readonly',
    CustomEvent: 'readonly',
    Event: 'readonly',
    Blob: 'readonly',
    File: 'readonly',
    FileReader: 'readonly',
    FormData: 'readonly',
    Image: 'readonly',
    Path2D: 'readonly',
    DOMParser: 'readonly',
    XMLSerializer: 'readonly',
    getComputedStyle: 'readonly',
    matchMedia: 'readonly',
    structuredClone: 'readonly',
    alert: 'readonly',
    confirm: 'readonly',
    prompt: 'readonly',
    crypto: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    OffscreenCanvas: 'readonly',
    createImageBitmap: 'readonly',
    // Provided as globals by the vendor <script> tags (see js/vendor/README.md)
    paper: 'readonly',
    JSZip: 'readonly',
    // DOM base classes and constructors (custom elements, geometry, events)
    HTMLElement: 'readonly',
    HTMLImageElement: 'readonly',
    HTMLCanvasElement: 'readonly',
    Node: 'readonly',
    Element: 'readonly',
    EventTarget: 'readonly',
    KeyboardEvent: 'readonly',
    PointerEvent: 'readonly',
    WheelEvent: 'readonly',
    MouseEvent: 'readonly',
    DragEvent: 'readonly',
    ClipboardEvent: 'readonly',
    customElements: 'readonly',
    CSS: 'readonly',
    DOMMatrix: 'readonly',
    DOMPoint: 'readonly',
    DOMRect: 'readonly',
    AbortController: 'readonly',
    AbortSignal: 'readonly',
    atob: 'readonly',
    btoa: 'readonly',
    indexedDB: 'readonly',
    requestIdleCallback: 'readonly',
    cancelIdleCallback: 'readonly',
};

export default [
    {
        ignores: [
            'js/vendor/**',
            'node_modules/**',
            'backend/**',
            'test/_archive/**',
        ],
    },
    {
        files: ['*.mjs', 'eslint.config.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { process: 'readonly', console: 'readonly', WebSocket: 'readonly' },
        },
        rules: { 'no-undef': 'error' },
    },
    {
        files: ['js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: BROWSER_GLOBALS,
        },
        rules: {
            // Real-defect classes: undefined variables, duplicate declarations, syntax-level issues
            'no-undef': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-class-members': 'error',
            'no-dupe-args': 'error',
            'no-unreachable': 'error',
            'no-cond-assign': 'error',
            'no-constant-condition': 'error',
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-fallthrough': 'error',
            'no-sparse-arrays': 'error',
            'no-unsafe-negation': 'error',
            'no-unsafe-optional-chaining': 'error',
            'no-self-assign': 'warn',
            'no-self-compare': 'warn',
            'no-unused-private-class-members': 'warn',
            'valid-typeof': 'error',
            'use-isnan': 'error',
            'no-unused-vars': ['warn', {
                args: 'none',
                caughtErrors: 'none',
                ignoreRestSiblings: true,
            }],
        },
    },
    {
        files: ['test/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                // Probes are Node-side programs; in-page globals only appear inside injected script strings
                ...BROWSER_GLOBALS,
                process: 'readonly',
                Buffer: 'readonly',
                WebSocket: 'readonly',
                AbortController: 'readonly',
                AbortSignal: 'readonly',
                atob: 'readonly',
                btoa: 'readonly',
                globalThis: 'readonly',
                clearImmediate: 'readonly',
                setImmediate: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': 'off',
        },
    },
];
