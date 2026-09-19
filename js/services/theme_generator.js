// js/services/theme_generator.js
// Generates a complete accent color palette from a single hue value.
// Uses HSL color space for intuitive hue-based generation.
//
// Architecture:
//   mainHue  → accent, accent-hover, accent-bg, canvas accent colors
//   highlightHue = (mainHue + 200) % 360 → selection, guide-hover, divider-highlight
//   Dark mode shifts hue +18° and adjusts lightness/saturation for dark backgrounds.
//
// Fixed constants (never change with accent):
//   --cvs-ctrl-back  (pure red)   — bezier handle back direction
//   --cvs-ctrl-ahead (pure blue)  — bezier handle ahead direction
//
// Dynamic (follow highlight hue):
//   --cvs-preview — path editing preview line

// ── Color Helpers ──────────────────────────────────────────────

/** HSL → CSS hex string (#rrggbb) */
export function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r, g, b;
    if (h < 60)       { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** HSL → CSS rgba() string */
export function hslToRgba(h, s, l, a = 1) {
    const hex = hslToHex(h, s, l);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (a >= 1) return `rgba(${r}, ${g}, ${b}, 1)`;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ── Presets ────────────────────────────────────────────────────

// `i18n` names the preset in the translation table and `name` is the English
// fallback used if the table is unavailable.
export const THEME_PRESETS = [
    { id: 'blue',   name: 'Blue',   i18n: 'accent.blue',   hue: 199, swatch: '#0284c7' },
    { id: 'red',    name: 'Red',    i18n: 'accent.red',    hue: 0,   swatch: '#dc2626' },
    { id: 'orange', name: 'Orange', i18n: 'accent.orange', hue: 25,  swatch: '#ea580c' },
    { id: 'green',  name: 'Green',  i18n: 'accent.green',  hue: 152, swatch: '#16a34a' },
    { id: 'teal',   name: 'Teal',   i18n: 'accent.teal',   hue: 175, swatch: '#0d9488' },
    { id: 'purple', name: 'Purple', i18n: 'accent.purple', hue: 270, swatch: '#9333ea' },
    { id: 'pink',   name: 'Pink',   i18n: 'accent.pink',   hue: 330, swatch: '#db2777' },
];

// ── Fixed Constants ────────────────────────────────────────────
// Control handle LINES — pure red/blue, never participate in accent switching.

export const FIXED_CONSTANTS = {
    '--cvs-ctrl-back':  'rgba(220, 38, 38, 0.9)',   // pure red
    '--cvs-ctrl-ahead': 'rgba(37, 99, 235, 0.9)',    // pure blue
};

// ── Palette Generator ──────────────────────────────────────────

/**
 * Generate the full accent palette from a single hue.
 *
 * @param {number} hue - Base hue in degrees (0–360)
 * @param {boolean} isDark - Whether dark mode is active
 * @returns {Object} Map of CSS variable names → values
 */
export function generateAccentPalette(hue, isDark) {
    const highlightHue = (hue + 200) % 360;
    const palette = {};

    if (isDark) {
        // ── Dark mode: UI accent only (canvas stays light) ──
        const h = hue + 18;
        palette['--ui-accent']       = hslToHex(h, 82, 62);
        palette['--ui-accent-hover'] = hslToHex(h, 88, 72);
        palette['--ui-accent-bg']    = hslToHex(h, 35, 22);
        palette['--ui-accent-bg-hover'] = hslToHex(h, 38, 28);
        palette['--ui-accent-text']  = '#ffffff';
    } else {
        // ── Light mode: UI accent ──
        palette['--ui-accent']       = hslToHex(hue, 98, 40);
        palette['--ui-accent-hover'] = hslToHex(hue, 93, 48);
        palette['--ui-accent-bg']    = hslToHex(hue, 56, 94);
        palette['--ui-accent-bg-hover'] = hslToHex(hue, 63, 88);
        palette['--ui-accent-text']  = hslToHex(hue, 98, 40);
    }

    // ── Canvas variables: always light-mode values (no dark conversion) ──
    palette['--cvs-oncurve-stroke'] = hslToRgba(hue, 98, 40, 1);
    palette['--cvs-oncurve-fill']   = hslToRgba(hue, 98, 40, 0.6);
    palette['--cvs-ctrl-stroke']    = hslToRgba(hue, 93, 48, 1);
    palette['--cvs-ctrl-fill']      = hslToRgba(hue, 93, 48, 0.6);

    palette['--cvs-hover-stroke']        = hslToRgba(hue, 98, 40, 1);
    palette['--cvs-select-box']          = hslToRgba(hue, 93, 48, 0.4);
    palette['--cvs-select-handle-stroke']= hslToHex(hue, 98, 40);
    palette['--cvs-marquee-stroke']      = hslToHex(hue, 93, 48);
    palette['--cvs-marquee-fill']        = hslToRgba(hue, 93, 48, 0.08);
    palette['--cvs-guide-stroke']        = hslToRgba(hue, 98, 40, 0.6);
    palette['--cvs-guide-fill']          = hslToRgba(hue, 98, 40, 0.4);

    palette['--cvs-selected-fill']       = hslToRgba(highlightHue, 96, 53, 0.5);
    palette['--cvs-selected-stroke']     = hslToRgba(highlightHue, 96, 53, 1);
    palette['--cvs-guide-hover-stroke']  = hslToRgba(highlightHue, 96, 53, 0.8);
    palette['--cvs-guide-hover-fill']    = hslToRgba(highlightHue, 96, 53, 0.6);
    palette['--cvs-guide-drag-stroke']   = hslToRgba(highlightHue, 96, 53, 0.7);
    palette['--cvs-guide-drag-fill']     = hslToRgba(highlightHue, 96, 53, 0.5);
    palette['--cvs-divider-highlight']   = hslToRgba(highlightHue, 96, 53, 0.8);
    palette['--cvs-measure-hover']       = hslToHex(highlightHue, 96, 53);
    palette['--cvs-preview']             = hslToRgba(highlightHue, 96, 53, 0.8);

    return palette;
}

// ── Apply / Clear ──────────────────────────────────────────────

/**
 * Apply a generated palette to the document.
 * Clears any previously generated accent overrides first,
 * then sets the new palette as inline styles on :root.
 *
 * For 'blue' (the CSS default), clears overrides so the
 * stylesheet values take effect unchanged.
 */
export function applyAccentPalette(hue, isDark) {
    const root = document.documentElement;

    // Generate the full palette first
    const palette = generateAccentPalette(hue, isDark);
    const fixed = FIXED_CONSTANTS;
    const allProps = { ...fixed, ...palette };

    // For blue (199°), clear overrides so CSS :root values take effect
    if (hue === 199) {
        root.removeAttribute('data-accent-hue');
        root.removeAttribute('data-accent-preset');
        // Clear any previously generated inline styles
        for (const prop of Object.keys(allProps)) {
            root.style.removeProperty(prop);
        }
        return;
    }

    // Apply all generated values in one batch (no clear-first to avoid CSS flash)
    for (const [prop, value] of Object.entries(allProps)) {
        root.style.setProperty(prop, value);
    }
}

/**
 * Clear all generated accent palette overrides from :root inline styles.
 */
export function clearAccentPalette(root) {
    root = root || document.documentElement;
    root.removeAttribute('data-accent-hue');
    root.removeAttribute('data-accent-preset');

    // All properties the generator may have set
    const accentProps = [
        '--ui-accent', '--ui-accent-hover', '--ui-accent-bg',
        '--ui-accent-bg-hover', '--ui-accent-text',
        '--cvs-oncurve-stroke', '--cvs-oncurve-fill',
        '--cvs-ctrl-stroke', '--cvs-ctrl-fill',
        '--cvs-hover-stroke', '--cvs-select-box',
        '--cvs-select-handle-stroke', '--cvs-marquee-stroke',
        '--cvs-marquee-fill', '--cvs-guide-stroke', '--cvs-guide-fill',
        '--cvs-selected-fill', '--cvs-selected-stroke',
        '--cvs-guide-hover-stroke', '--cvs-guide-hover-fill',
        '--cvs-guide-drag-stroke', '--cvs-guide-drag-fill',
        '--cvs-divider-highlight', '--cvs-measure-hover',
        '--cvs-ctrl-back', '--cvs-ctrl-ahead', '--cvs-preview',
    ];
    for (const prop of accentProps) {
        root.style.removeProperty(prop);
    }
}

/**
 * Find a preset by its hue value.
 * Returns the preset object or null.
 */
export function findPresetByHue(hue) {
    return THEME_PRESETS.find(p => p.hue === hue) || null;
}

/**
 * Find the closest preset to a given hue.
 */
export function findClosestPreset(hue) {
    let best = THEME_PRESETS[0];
    let bestDist = Infinity;
    for (const p of THEME_PRESETS) {
        // Circular distance on hue wheel
        let dist = Math.abs(p.hue - hue);
        if (dist > 180) dist = 360 - dist;
        if (dist < bestDist) {
            bestDist = dist;
            best = p;
        }
    }
    return best;
}
