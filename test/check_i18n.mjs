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
//   MISSING  — a key one locale defines and another does not. Every locale must
//              cover the same key set, otherwise switching language silently falls
//              back to English for the gap.
//   UNTRANSLATED — a key whose value is byte-identical in both locales. Unless
//              the string is language-neutral by nature (a glyph name, a unit),
//              that means the translation was never written and the Chinese UI
//              silently shows English.
//
// Usage:
//   node test/check_i18n.mjs
// Exits 1 when any DANGLING/MISSING key exists, or any ORPHANED key outside STAGED.
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

/** Values that are the same in every locale on purpose: proper nouns and ASCII art. */
const LANGUAGE_NEUTRAL = new Set([
    "app.title" // the product name
]);

/** Body of one locale object: `{"key": "value", ...}` of its top-level block. */
function localeBody(name) {
    // The last locale in the object closes with `};` instead of `    },`.
    const body = source.match(new RegExp(`\\n    ${name}: \\{([\\s\\S]*?)\\n(?:    \\},|\\};)`));
    if (!body) throw new Error(`locale "${name}" not found in ${TABLE}`);
    return body[1];
}

/** key -> raw value (escapes kept as written) for one locale. */
function localeValues(name) {
    const out = new Map();
    for (const m of localeBody(name).matchAll(/"([a-zA-Z][a-zA-Z0-9_.]*)"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
        out.set(m[1], m[2]);
    }
    return out;
}

const enValues = localeValues("en");
const zhValues = localeValues("zh");
const enKeys = new Set(enValues.keys());
const zhKeys = new Set(zhValues.keys());
// The English table defines the canonical key set; `en` is also what every
// markup fallback is written in, so it is the side that must never lose a key.
const defined = enKeys;
const missing = [...enKeys].filter(k => !zhKeys.has(k)).sort();
const unknown = [...zhKeys].filter(k => !enKeys.has(k)).sort();
const untranslated = [...enKeys]
    .filter(k => zhKeys.has(k) && !LANGUAGE_NEUTRAL.has(k))
    .filter(k => enValues.get(k) === zhValues.get(k))
    .sort();

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
    /\btCount\(\s*['"]([^'"]+)['"]/g,                // "{n}"-templated lookups
    /\btr\(\s*['"]([^'"]+)['"]/g,                   // local alias of the same helper
    /\bsetI18n(?:Text|Tip|Placeholder)\(\s*\w+\s*,\s*['"]([^'"]+)['"]/g,  // element + key
    /\b(?:i18n|key)\s*:\s*['"]([^'"]+)['"]/g,        // menu item / colour row / preset
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

console.log(`i18n keys defined ${defined.size} (en) / ${zhKeys.size} (zh) | referenced ${used.size} | staged ${STAGED.size} | untranslated ${untranslated.length}`);

for (const key of dangling) console.log(`  DANGLING  ${key}  <- ${[...used.get(key)].join(", ")}`);
for (const key of orphaned) console.log(`  ORPHANED  ${key}  (defined but never referenced)`);
for (const key of missing) console.log(`  MISSING   ${key}  (defined in en, absent from zh)`);
for (const key of unknown) console.log(`  UNKNOWN   ${key}  (defined in zh, absent from en)`);
for (const key of untranslated) console.log(`  UNTRANSLATED  ${key}  = "${enValues.get(key)}"`);
for (const key of staleStaged) console.log(`  STALE     ${key}  (in STAGED but referenced or undefined)`);

const failed = dangling.length || orphaned.length || missing.length || unknown.length
    || staleStaged.length || untranslated.length;
console.log(failed
    ? `\nFAIL: ${dangling.length} dangling, ${orphaned.length} orphaned, ${missing.length} missing, ${unknown.length} unknown, ${staleStaged.length} stale staged, ${untranslated.length} untranslated`
    : "OK: locales match, every referenced key is defined, every defined key is referenced or staged, nothing left untranslated");
process.exit(failed ? 1 : 0);
