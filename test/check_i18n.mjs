// test/check_i18n.mjs — static consistency check for the UI text table.
//
// The frontend keeps every user-visible string in one table (js/services/i18n.js)
// and references it by key from markup (`data-i18n*`) or from JS (`t('key')`, a
// menu item's `i18n:` field, a colour row's `key:` field). This check enforces
// both directions of that contract:
//
//   DANGLING — a key referenced somewhere but missing from the table. Before the
//              fallback fix in I18nManager.t() this rendered the raw key as UI text.
//   ORPHANED — a key in the table that nothing references: dead text that rots
//              silently. That is how the authored "(bottom minus top)" hint was
//              lost — the markup had it, the table did not, and the table won.
//
// Usage:
//   node test/check_i18n.mjs
// Exits 1 when any DANGLING key exists, or any ORPHANED key outside STAGED.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TABLE = join(REPO, "js", "services", "i18n.js");

/**
 * Keys that are intentionally defined ahead of the UI that will use them.
 * Each entry needs a reason; anything else must be referenced or deleted.
 */
const STAGED = new Set([
    // One label per --cvs-* custom property in css/style.css, so a colour palette
    // panel can list the remaining variables without inventing names. Only
    // color.path_stroke and color.ctrl_stroke are exposed in Preferences today.
    "color.path_fill", "color.preview", "color.hover_stroke",
    "color.oncurve_stroke", "color.oncurve_fill",
    "color.selected_stroke", "color.selected_fill",
    "color.ctrl_fill", "color.ctrl_ahead", "color.ctrl_back",
    "color.guideline", "color.measure", "color.select_box", "color.body_bg"
]);

const source = readFileSync(TABLE, "utf8");
const enBody = source.slice(
    source.indexOf("en: {") + 5,
    source.indexOf("\n};", source.indexOf("en: {"))
);
const defined = new Set([...enBody.matchAll(/"([a-z][a-zA-Z0-9_.]*)"\s*:/g)].map(m => m[1]));

// The namespaces the table declares. Restricting candidates to these keeps dots
// in unrelated literals ("metainfo.plist", zip.folder("font.ufo")) out of the scan.
const namespaces = new Set([...defined].map(k => k.split(".")[0]));

function jsFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "vendor") continue;
        if (statSync(p).isDirectory()) jsFiles(p, out);
        else if (name.endsWith(".js")) out.push(p);
    }
    return out;
}

const USAGE = [
    /data-i18n(?:-tip|-placeholder)?="([^"]+)"/g,   // markup
    /\bt\(\s*['"]([^'"]+)['"]/g,                      // t('key') / I18n.t('key')
    /\b(?:i18n|key)\s*:\s*['"]([^'"]+)['"]/g,        // menu item / colour row
    /\b(?:makeItem|makeToggle|makePanelToggle)\(\s*['"]([^'"]+)['"]/g
];

const used = new Map(); // key -> Set(relative file)
const scan = [join(REPO, "index.html"), ...jsFiles(join(REPO, "js"))].filter(p => p !== TABLE);
const rel = f => f.slice(REPO.length + 1).replace(/\\/g, "/");

for (const file of scan) {
    const src = readFileSync(file, "utf8");
    for (const re of USAGE) {
        for (const m of src.matchAll(re)) {
            const key = m[1];
            if (!namespaces.has(key.split(".")[0])) continue;
            if (!used.has(key)) used.set(key, new Set());
            used.get(key).add(rel(file));
        }
    }
}

const dangling = [...used.keys()].filter(k => !defined.has(k)).sort();
const orphaned = [...defined].filter(k => !used.has(k) && !STAGED.has(k)).sort();
const staleStaged = [...STAGED].filter(k => used.has(k) || !defined.has(k)).sort();

console.log(`i18n keys defined ${defined.size} | referenced ${used.size} | staged ${STAGED.size}`);

for (const key of dangling) console.log(`  DANGLING  ${key}  <- ${[...used.get(key)].join(", ")}`);
for (const key of orphaned) console.log(`  ORPHANED  ${key}  (defined but never referenced)`);
for (const key of staleStaged) console.log(`  STALE     ${key}  (in STAGED but referenced or undefined)`);

const failed = dangling.length || orphaned.length || staleStaged.length;
console.log(failed
    ? `\nFAIL: ${dangling.length} dangling, ${orphaned.length} orphaned, ${staleStaged.length} stale staged`
    : "OK: every referenced key is defined, every defined key is either referenced or staged");
process.exit(failed ? 1 : 0);
