// test/check_fonts.mjs — the UI must not name a font family.
//
// The editor ships on Windows, Linux and macOS and renders inside a WebView whose font
// stack is whatever the platform provides. Naming a family ("Segoe UI", Consolas, Menlo…)
// therefore either does nothing on the other platforms or silently substitutes a face the
// user never chose, which is exactly the "everything looks slightly off" bug this check
// exists to prevent. Only generic keywords are allowed; the platform picks the face.
//
// Usage:
//   node test/check_fonts.mjs
// Exits 1 when any declaration names a family or uses an unknown keyword.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** CSS-wide generic families the browser resolves per platform. */
const GENERIC = new Set([
    "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
    "sans-serif", "serif", "monospace", "cursive", "fantasy",
    "math", "emoji", "fangsong"
]);
/** Values that inherit instead of naming anything. */
const PASS_THROUGH = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

function cssFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) cssFiles(p, out);
        else if (name.endsWith(".css")) out.push(p);
    }
    return out;
}

const files = [join(REPO, "css"), join(REPO, "assets")]
    .filter(p => { try { return statSync(p).isDirectory(); } catch { return false; } })
    .flatMap(dir => cssFiles(dir));
// index.html carries a few inline styles of its own.
files.push(join(REPO, "index.html"));

const problems = [];
let declarations = 0;
for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/font-family\s*:\s*([^;{}]*)[;}]/g)) {
        declarations++;
        const raw = m[1].trim();
        const tokens = raw.split(",").map(t => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        for (const token of tokens) {
            const lower = token.toLowerCase();
            if (GENERIC.has(lower) || PASS_THROUGH.has(lower)) continue;
            // A CSS custom property expands to a stack we cannot resolve statically.
            if (lower.startsWith("var(")) continue;
            const line = src.slice(0, m.index).split("\n").length;
            problems.push(`${file.slice(REPO.length + 1).replace(/\\/g, "/")}:${line}  "${token}" in \`font-family: ${raw}\``);
        }
    }
}

console.log(`font-family declarations checked: ${declarations} in ${files.length} file(s)`);
for (const p of problems) console.log(`  NAMED FONT  ${p}`);
console.log(problems.length
    ? `FAIL: ${problems.length} font-family declaration(s) name a specific font — use a generic family`
    : "OK: every font-family uses generic families only");
process.exit(problems.length ? 1 : 0);
