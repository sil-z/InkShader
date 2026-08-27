import { CanvasDispatcher } from "../../app/canvas_dispatcher.js";
import { StorageUtils } from "../../services/storage.js";
import { appendCurveOutlinePath, curveGeneratesFillArea } from "../rendering/curve_renderer.js";
import { generateMarker } from "../../core/bezier/utils.js";
import { CurveNode } from "../../core/bezier/node.js";
import svgpath from "../../vendor/svgpath.min.js";
export class CanvasIOService {
    constructor(canvas) {
        this.canvas = canvas;
    }
    triggerImportImage() {
        const c = this.canvas;
        const input = c.env.createDOMElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    c.io.importImageToCurrentGroup(img, file.name);
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        };
        input.click();
    }
    importImageToCurrentGroup(imgObj, fileName) {
        const c = this.canvas;
        const id = c.curve_manager.importImageToCurrentGroup(imgObj, fileName);
        if (!id) return;
        c.is_dirty = true;
        if (!c.commitCommandHistory?.({ commandName: "importImageToCurrentGroup", payload: { imageId: id, fileName } })) {
            CanvasDispatcher.requestHistoryCommit("importImageToCurrentGroup", { imageId: id, fileName });
        }
    }
    save_file(extraState = {}) {
        const c = this.canvas;
        return c.curve_manager.exportJSON({
            guidelines: (c.guidelines || []).filter(g => !g._temp).map(g => ({
                id: g.id, x: g.x, y: g.y, angle: g.angle
            })),
            font_settings: c.fontSettings || {},
            canvas_size_width: c.canvas_size_width,
            canvas_size_height: c.canvas_size_height
        }, extraState);
    }
    triggerLoad() {
        const c = this.canvas;
        const input = c.env.createDOMElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                const jsonStr = event.target.result;
                // Use ProjectManager to handle save-before-switch and name conflict
                const pm = c.projectManager;
                if (pm) {
                    const result = await pm.loadFromFile(jsonStr);
                } else {
                    // Fallback: direct load (no ProjectManager)
                    try {
                        await c.commands.loadSnapshotCommand(jsonStr);
                        c.commandStack = [];
                        c.redoCommandStack = [];
                        c.currentStateObj = c.history.getHistoryState();
                        if (typeof c.history._flushRuntimeStateSave === "function") c.history._flushRuntimeStateSave();
                        c.history.saveCurrentViewState(true);
                        c.notifyPropertiesUpdate();
                        c.is_dirty = true;
                        c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
                    } catch (err) {
                        console.error("[CanvasIO] Critical error during file loading:", err);
                        alert("Critical error during file loading: " + err.message);
                    }
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }
    triggerSave() {
        const c = this.canvas;
        const active = document.activeElement;
        if (active && document.querySelector('font-popup')?.contains(active)) {
            active.blur();
        }
        const jsonStr = c.io.save_file();
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = c.env.createObjectURL(blob);
        const a = c.env.createDOMElement("a");
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
        a.download = `InkShader_project_${dateStr}.json`;
        const bodyDOM = c.env.queryDOM("body");
        if (bodyDOM) {
            bodyDOM.appendChild(a);
            a.click();
            bodyDOM.removeChild(a);
        }
        c.env.revokeObjectURL(url);
        c.currentStateObj = c.history.getHistoryState();
        if (typeof c.history._flushRuntimeStateSave === "function") c.history._flushRuntimeStateSave();
    }
    // Escape XML special characters for safe plist string content
    _escXml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    // Reverse of _escXml: decode XML entities from parsed plist string values
    _unescapeXml(s) {
        return String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }

    /**
     * UFO 3 user name → file name conversion (the "common algorithm" from
     * the UFO conventions, as implemented by fontTools ufoLib filenames.py):
     *   - a leading "." becomes "_"
     *   - illegal characters are replaced with "_"
     *   - every uppercase character gets a trailing "_" (A → "A_"), so
     *     names that differ only in case (e.g. "A" vs "a") can never
     *     collide on case-insensitive file systems
     *   - reserved Windows names (con, aux, ...) get a "_" prefix, checked
     *     per dot-separated part
     *   - the name is clipped to 255 chars total and made unique (case-
     *     insensitively) against `existing` by appending a zero-padded
     *     counter
     * @param {string} userName - Glyph name
     * @param {Set<string>} existing - Lowercase file names already in use
     * @param {string} [suffix] - File extension, default ".glif"
     * @returns {string} File name
     */
    _ufoFileName(userName, existing, suffix = ".glif") {
        const illegal = new Set([
            ...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)),
            '"', '*', '+', '/', ':', '<', '>', '?', '[', '\\', ']', '(', ')', '|', '\x7f'
        ]);
        const reserved = new Set(["aux", "clock$", "com1", "com2", "com3", "com4", "com5",
            "com6", "com7", "com8", "com9", "con", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5",
            "lpt6", "lpt7", "lpt8", "lpt9", "nul", "prn"]);
        // leading "." → "_"
        let name = userName[0] === "." ? "_" + userName.slice(1) : userName;
        // illegal chars → "_"; uppercase chars get a trailing "_"
        let filtered = "";
        for (const ch of name) {
            filtered += illegal.has(ch) ? "_" : (ch !== ch.toLowerCase() ? ch + "_" : ch);
        }
        name = filtered;
        // clip so the full file name (with suffix) fits in 255 chars
        name = name.slice(0, 255 - suffix.length);
        // reserved names: prefix "_" to each matching dot-separated part
        name = name.split(".").map(p => reserved.has(p.toLowerCase()) ? "_" + p : p).join(".");
        const full = name + suffix;
        if (existing.has(full.toLowerCase())) {
            // clash: append a 15-digit zero-padded counter (fontTools handleClash1)
            name = name.slice(0, 255 - suffix.length - 15);
            let counter = 1;
            while (counter < 999999999999999) {
                const cand = name + String(counter).padStart(15, "0") + suffix;
                if (!existing.has(cand.toLowerCase())) return cand;
                counter++;
            }
        }
        return full;
    }

    exportToUFO() {
        const c = this.canvas;
        const active = document.activeElement;
        if (active && document.querySelector('font-popup')?.contains(active)) {
            active.blur();
        }
        if (typeof JSZip === "undefined") {
            alert("JSZip library is not loaded. Cannot export UFO.");
            return;
        }
        const esc = (s) => this._escXml(s);
        let fontSettings = {
            family: "InkShader Font",
            style: "Regular",
            upm: 1000,
            ascender: 800,
            descender: -200,
            version: "1.0",
            ...(c.fontSettings || {})
        };
        let [vMaj, vMin] = fontSettings.version.split(".");
        vMaj = parseInt(vMaj, 10) || 1;
        vMin = parseInt(vMin, 10) || 0;
        const zip = new JSZip();
        // UFO ZIP spec: "All contents of the UFO must be contained within a
        // single directory" (e.g. font.ufo/metainfo.plist) — files at the
        // archive root are not valid. Import accepts both shapes, so older
        // exports still round-trip.
        const ufoFolder = zip.folder("font.ufo");
        const glyphsFolder = ufoFolder.folder("glyphs");

        // ── Build fontinfo.plist (all metadata fields from fontSettings) ──
        const fi = [];
        const fiKV = (key, type, val) => {
            if (val === undefined || val === null) return;
            const v = type === 'string' ? esc(val)
                : type === 'real' ? Number(val)
                : Math.round(Number(val));
            fi.push(`    <key>${key}</key><${type}>${v}</${type}>`);
        };
        fiKV('ascender', 'integer', fontSettings.ascender);
        fiKV('capHeight', 'integer', fontSettings.cap_height);
        fiKV('copyright', 'string', fontSettings.copyright);
        fiKV('descender', 'integer', fontSettings.descender);
        fiKV('familyName', 'string', fontSettings.family);
        fiKV('postscriptFontName', 'string', fontSettings.postscript_name);
        fiKV('postscriptFullName', 'string', (fontSettings.family + ' ' + fontSettings.style).trim());
        // Custom field: preserve InkShader project_name through round-trip
        fiKV('com.inkshader.projectName', 'string', fontSettings.project_name);
        fiKV('styleName', 'string', fontSettings.style);
        fiKV('trademark', 'string', fontSettings.trademark);
        fiKV('unitsPerEm', 'integer', fontSettings.upm);
        fiKV('versionMajor', 'integer', vMaj);
        fiKV('versionMinor', 'integer', vMin);
        fiKV('xHeight', 'integer', fontSettings.x_height);
        fiKV('italicAngle', 'real', fontSettings.italic_angle ?? 0);

        // OpenType name table fields
        fiKV('openTypeNameDesigner', 'string', fontSettings.designer);
        fiKV('openTypeNameDesignerURL', 'string', fontSettings.designer_url);
        fiKV('openTypeNameManufacturer', 'string', fontSettings.manufacturer);
        fiKV('openTypeNameManufacturerURL', 'string', fontSettings.manufacturer_url);
        fiKV('openTypeNameLicense', 'string', fontSettings.license);
        fiKV('openTypeNameLicenseURL', 'string', fontSettings.license_url);
        fiKV('openTypeNameVersion', 'string', fontSettings.version);
        fiKV('openTypeNameDescription', 'string', fontSettings.description);
        fiKV('openTypeNameSampleText', 'string', fontSettings.sample_text);
        fiKV('openTypeNamePreferredFamilyName', 'string', fontSettings.preferred_family);
        fiKV('openTypeNamePreferredSubfamilyName', 'string', fontSettings.preferred_subfamily);
        // Only write styleMapFamilyName when non-empty so compilers fall back to familyName
        if (fontSettings.style_map_family) {
            fiKV('styleMapFamilyName', 'string', fontSettings.style_map_family);
        }
        // Derive openTypeNameUniqueID (name ID 3) in the spec-recommended
        // "Version;Vendor;Family-Style" format from existing fields
        const uniqueId = [fontSettings.version, fontSettings.manufacturer,
            `${fontSettings.family}-${fontSettings.style}`].filter(Boolean).join(';');
        fiKV('openTypeNameUniqueID', 'string', uniqueId);

        // OpenType OS/2 table fields
        fiKV('openTypeOS2WeightClass', 'integer', fontSettings.weight_class);
        fiKV('openTypeOS2WidthClass', 'integer', fontSettings.width_class);
        // OS/2 typo metrics: derive from the generic ascender/descender so the
        // values stay consistent (compilers would otherwise do the same fallback)
        fiKV('openTypeOS2TypoAscender', 'integer', fontSettings.ascender);
        fiKV('openTypeOS2TypoDescender', 'integer', fontSettings.descender);
        fiKV('openTypeOS2TypoLineGap', 'integer', 0);

        // Guidelines (from canvas, Y-flipped to UFO coordinate space)
        const guidelines = (c.guidelines || []).filter(g => !g._temp);
        if (guidelines.length > 0) {
            fi.push('    <key>guidelines</key>\n    <array>');
            for (const g of guidelines) {
                fi.push('      <dict>');
                fi.push(`        <key>x</key><integer>${Math.round(g.x)}</integer>`);
                fi.push(`        <key>y</key><integer>${Math.round((c.fontSettings?.ascender ?? 800) - g.y)}</integer>`);
                if (g.angle != null && g.angle !== 0) {
                    fi.push(`        <key>angle</key><integer>${Math.round(g.angle)}</integer>`);
                }
                fi.push('      </dict>');
            }
            fi.push('    </array>');
        }

        ufoFolder.file("fontinfo.plist", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${fi.join('\n')}
</dict>
</plist>`);
        ufoFolder.file("metainfo.plist", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict><key>creator</key><string>org.InkShader.editor</string><key>formatVersion</key><integer>3</integer></dict>
</plist>`);
        ufoFolder.file("layercontents.plist", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><array><string>public.default</string><string>glyphs</string></array></array></plist>`);
        let contentsDict = "";

        // GlifRecorder: produces GLIF outline XML (contours + components)
        class GlifRecorder {
            constructor(ascender) {
                this.contours = [];
                this.components = [];
                this.currentContour = null;
                this.asc = ascender;
                this._smoothMode = undefined;
            }
            _fy(y) { return this.asc - y; }
            /** Persist the control_mode of the next on-curve point (GLIF smooth="yes" export). */
            setSmoothMode(mode) { this._smoothMode = mode; }
            moveTo(x, y) {
                this._flushContour();
                this.currentContour = { closed: false, points: [] };
                this.currentContour.points.push({ x, y, type: "move", smooth: this._smoothMode });
            }
            lineTo(x, y) {
                if (this.currentContour) this.currentContour.points.push({ x, y, type: "line", smooth: this._smoothMode });
            }
            bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
                if (this.currentContour) {
                    // Per GLIF spec, control points must be type="offcurve"
                    // (import now distinguishes them from on-curve points)
                    this.currentContour.points.push({ x: c1x, y: c1y, type: "offcurve" });
                    this.currentContour.points.push({ x: c2x, y: c2y, type: "offcurve" });
                    this.currentContour.points.push({ x, y, type: "curve", smooth: this._smoothMode });
                }
            }
            arc(x, y, radius, startAngle, endAngle, counterClockwise) {
                const steps = 4;
                let diff = endAngle - startAngle;
                if (counterClockwise && diff > 0) diff -= Math.PI * 2;
                else if (!counterClockwise && diff < 0) diff += Math.PI * 2;
                for (let i = 1; i <= steps; i++) {
                    const a = startAngle + diff * (i / steps);
                    this.lineTo(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
                }
            }
            closePath() {
                if (this.currentContour) this.currentContour.closed = true;
            }
            _flushContour() {
                if (this.currentContour) {
                    if (this.currentContour.closed && this.currentContour.points.length > 0) {
                        if (this.currentContour.points[0].type === "move") this.currentContour.points[0].type = "line";
                    }
                    this.contours.push(this.currentContour);
                    this.currentContour = null;
                }
            }
            /** Register a component reference (UFO coordinate space transforms). */
            addComponent(baseName, a, b, c, d, e, f, refName = null) {
                this.components.push({ baseName, a, b, c, d, e, f, refName });
            }
            /**
             * Classify an on-curve point's smoothness from EXACT recorder
             * coordinates (before Math.round). Used for generated outline points
             * (expanded smart strokes) that carry no node metadata — the same
             * tolerance convention as _classifyControlModeFromGeometry.
             * @returns {boolean} true when the node is smooth/symmetric
             */
            _classifyPointSmooth(points, i) {
                const n = points.length;
                const p = points[i];
                const isOff = (q) => q && q.type === "offcurve";
                const c1 = isOff(points[(i + 1) % n]) ? points[(i + 1) % n] : null;
                const c2 = isOff(points[(i - 1 + n) % n]) ? points[(i - 1 + n) % n] : null;
                // Round-trip guard: GLIF stores Math.round() coordinates, so a
                // handle that rounds ONTO the on-curve point imports as a
                // zero-length handle and is dropped by the importer (PASS 2
                // skips off-curves coincident with the node) — leaving the node
                // with fewer effective handles. Classify from the handle count
                // the IMPORTER will reconstruct: 0 → corner, 1 → smooth, 2 →
                // geometric check. Prevents smooth="yes" on a node that will
                // import as a corner (degenerate near-zero segments).
                const roundsOntoPoint = (q) => q
                    && Math.round(q.x) === Math.round(p.x)
                    && Math.round(q.y) === Math.round(p.y);
                const effective = (q) => (q != null && !roundsOntoPoint(q)) ? 1 : 0;
                const h1 = effective(c1), h2 = effective(c2);
                if (h1 + h2 === 0) return false;
                if (h1 + h2 === 1) return true; // single handle → smooth
                const v1x = c1.x - p.x, v1y = c1.y - p.y;
                const v2x = c2.x - p.x, v2y = c2.y - p.y;
                const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
                if (l1 < 1e-9 || l2 < 1e-9) return false;
                const cross = v1x * v2y - v1y * v2x;
                const dot = v1x * v2x + v1y * v2y;
                if (Math.abs(cross) / (l1 * l2) > 5e-3) return false; // not collinear
                // Collinearity tolerance 5e-3 (~0.29°): true smooth points deviate
                // from exact collinearity by up to ~0.3° due to coordinate rounding
                // in export/drawing (measured: user case 0.1°, corpus 0.03-0.29°).
                // Costs: near-collinear corners (<0.29°) also classify smooth.
                if (dot >= 0) return false; // same direction
                return true; // opposite collinear → smooth
            }
            getXML() {
                this._flushContour();
                let xml = "";
                // Components first (per UFO spec: before contours)
                for (const comp of this.components) {
                    let attrs = `base="${esc(comp.baseName)}"`;
                    if (comp.a !== 1) attrs += ` xScale="${parseFloat(comp.a.toFixed(5))}"`;
                    if (comp.b !== 0) attrs += ` xyScale="${parseFloat(comp.b.toFixed(5))}"`;
                    if (comp.c !== 0) attrs += ` yxScale="${parseFloat(comp.c.toFixed(5))}"`;
                    if (comp.d !== 1) attrs += ` yScale="${parseFloat(comp.d.toFixed(5))}"`;
                    if (comp.e !== 0) attrs += ` xOffset="${parseFloat(comp.e.toFixed(5))}"`;
                    if (comp.f !== 0) attrs += ` yOffset="${parseFloat(comp.f.toFixed(5))}"`;
                    // Preserve the ref group's own name so a UFO round-trip
                    // restores "test_Ref_12" instead of renumbering to test_Ref_3.
                    if (comp.refName) attrs += ` data-ref-name="${esc(comp.refName)}"`;
                    xml += `    <component ${attrs}/>\n`;
                }
                // Contours
                for (const contour of this.contours) {
                    if (contour.points.length === 0) continue;
                    const pts = contour.points;
                    xml += "    <contour>\n";
                    for (let i = 0; i < pts.length; i++) {
                        const p = pts[i];
                        // GLIF native smooth attribute (UFO point metadata) preserves
                        // node smoothness across round-trip: smooth="yes" for
                        // smooth/symmetric, smooth="no" for corners. Skeleton paths
                        // use the node's control_mode; generated outline points
                        // (expanded smart strokes) are classified from EXACT
                        // coordinates here. Off-curve points never carry it.
                        let smoothAttr = '';
                        if (p.type !== "offcurve") {
                            const smoothVal = p.smooth != null
                                ? p.smooth > 0
                                : this._classifyPointSmooth(pts, i);
                            smoothAttr = ` smooth="${smoothVal ? 'yes' : 'no'}"`;
                        }
                        if (p.type === "") xml += `      <point x="${Math.round(p.x)}" y="${Math.round(this._fy(p.y))}"${smoothAttr}/>\n`;
                        else xml += `      <point x="${Math.round(p.x)}" y="${Math.round(this._fy(p.y))}" type="${p.type}"${smoothAttr}/>\n`;
                    }
                    xml += "    </contour>\n";
                }
                return xml;
            }
        }

        // ── Recursively collect GLIF outline for a group ──
        // This mirrors getCurvesForGroup but preserves component references
        // as <component> elements instead of flattening them into contours.
        const buildGlyphOutline = (recorder, groupId, matrix) => {
            const grpItem = c.curve_manager.treeItems.get(groupId);
            if (!grpItem || !grpItem.children) return;

            for (const childId of grpItem.children) {
                const child = c.curve_manager.treeItems.get(childId);
                if (!child) continue;

                if (child.type === 'curve') {
                    // Reset per curve: emitCubicBezierSegments re-sets smooth per
                    // on-curve point from skeleton nodes; expanded stroke outlines
                    // (generated geometry, no nodes) must NOT inherit a stale value.
                    if (typeof recorder.setSmoothMode === "function") recorder.setSmoothMode(undefined);
                    const curve = c.curve_manager.curveById.get(child.curveId);
                    // Closed fill rings export as closed contours; OPEN curves
                    // (e.g. imported from an open GLIF contour) export as open
                    // contours with a leading move point — GLIF supports both.
                    if (curve && curve.startNode && curve.visible !== false
                        && (curveGeneratesFillArea(curve) || !curve.closed)) {
                        appendCurveOutlinePath(recorder, curve, {
                            scale: 1, offsetX: 0, offsetY: 0, seqOffsetX: 0,
                            matrix: matrix || null
                        }, { pass: "fill" });
                    }
                } else if (child.type === 'group') {
                    if (child.isRef) {
                        const refTarget = c.curve_manager.treeItems.get(child.refId);
                        if (this._isRefToRootGlyph(child)) {
                            // Export as <component> — any root-level glyph can
                            // be a component base in UFO, unicode or not.
                            // (Previously gated on charCode != null, which
                            // flattened refs to unicode-less glyphs such as
                            // "test" and lost the reference on round-trip.)
                            const m = child.transform || new DOMMatrix();
                            const asc = c.fontSettings?.ascender ?? 800;
                            // Convert canvas-space transform (Y-down) to UFO Y-up space
                            const ufoA = m.a;
                            const ufoB = -m.b;
                            const ufoC = -m.c;
                            const ufoD = m.d;
                            const ufoE = m.e + m.c * asc;
                            const ufoF = -m.f + asc - m.d * asc;
                            recorder.addComponent(refTarget.name, ufoA, ufoB, ufoC, ufoD, ufoE, ufoF, child.name);
                        } else if (refTarget) {
                            // Ref to non-glyph (subgroup): resolve manually with transform
                            const childMatrix = matrix
                                ? new DOMMatrix(matrix).multiply(child.transform || new DOMMatrix())
                                : new DOMMatrix(child.transform || new DOMMatrix());
                            buildGlyphOutline(recorder, child.refId, childMatrix);
                        }
                    } else {
                        // Non-ref sub-group: recurse
                        buildGlyphOutline(recorder, childId, matrix);
                    }
                }
            }
        };

        // ── Iterate root-level glyphs and export GLIF files ──
        const glifCache = c.curve_manager._glifExportCache;
        // Lowercase file names already used. Glyph names that differ only
        // in case ("A" vs "a") get distinct spec file names ("A_.glif" vs
        // "a.glif") and never collide on case-insensitive file systems;
        // true duplicates get a counter suffix.
        const usedFileNames = new Set();
        for (const rootChildId of (c.curve_manager.rootChildren || [])) {
            const item = c.curve_manager.treeItems.get(rootChildId);
            if (!item || item.isRef) continue;
            const glyphName = item.name;
            const fileName = this._ufoFileName(glyphName, usedFileNames);
            usedFileNames.add(fileName.toLowerCase());
            const advance = item.advance !== undefined ? item.advance : 1000;
            contentsDict += `    <key>${glyphName}</key>\n    <string>${fileName}</string>\n`;

            // Reuse cached GLIF when glyph unchanged
            const cached = glifCache.get(item.id);
            if (cached && cached[0] === advance) {
                glyphsFolder.file(fileName, cached[1]);
                continue;
            }

            // Ligature glyphs (multi-char charCode) have no unicode value in GLIF.
            // Their substitution is defined via features.fea.
            const isLigature = item.charCode != null && Array.from(String(item.charCode)).length > 1;
            let unicodeTag = '';
            if (item.charCode != null && !isLigature) {
                // codePointAt (not charCodeAt): correct hex for astral characters
                unicodeTag = `<unicode hex="${String(item.charCode).codePointAt(0).toString(16).padStart(4, "0").toUpperCase()}"/>`;
            }
            const recorder = new GlifRecorder(c.fontSettings?.ascender ?? 800);
            buildGlyphOutline(recorder, item.id, null);

            const outlineXML = recorder.getXML();
            const glifXML = `<?xml version="1.0" encoding="UTF-8"?>
<glyph name="${glyphName}" format="2">
  <advance width="${advance}"/>
  ${unicodeTag}
  <outline>\n${outlineXML}  </outline>\n</glyph>`;
            glifCache.set(item.id, [advance, glifXML]);
            glyphsFolder.file(fileName, glifXML);
        }
        glyphsFolder.file("contents.plist", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">\n<dict>\n${contentsDict}</dict>\n</plist>`);

        // ── Build groups.plist for kerning classes ──
        const km = c.curve_manager?.kerningManager;
        if (km) {
            const groupsDict = [];
            // Left kern classes → public.kern1.{name}
            for (const { name, members } of km.getAllClassesWithMembers('left')) {
                groupsDict.push(`    <key>public.kern1.${esc(name)}</key>`);
                groupsDict.push('    <array>');
                for (const m of members) groupsDict.push(`        <string>${esc(m)}</string>`);
                groupsDict.push('    </array>');
            }
            // Right kern classes → public.kern2.{name}
            for (const { name, members } of km.getAllClassesWithMembers('right')) {
                groupsDict.push(`    <key>public.kern2.${esc(name)}</key>`);
                groupsDict.push('    <array>');
                for (const m of members) groupsDict.push(`        <string>${esc(m)}</string>`);
                groupsDict.push('    </array>');
            }
            if (groupsDict.length > 0) {
                ufoFolder.file("groups.plist", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${groupsDict.join('\n')}
</dict>
</plist>`);
            }

            // ── Build kerning.plist (class references + exception pairs) ──
            const kernDict = [];
            // Class-to-class values
            for (const { leftClass, rightClass, value } of km.getAllClassValues()) {
                kernDict.push(`    <key>public.kern1.${esc(leftClass)}</key>`);
                kernDict.push('    <dict>');
                kernDict.push(`        <key>public.kern2.${esc(rightClass)}</key>`);
                kernDict.push(`        <integer>${Math.round(value)}</integer>`);
                kernDict.push('    </dict>');
            }
            // Exception pairs (exact glyph names)
            for (const { left, right, value } of km.getAllPairs()) {
                if (Math.round(value) === 0) {
                    // kerning.plist spec: zero-valued pairs should not be
                    // stored — UNLESS they are necessary exceptions that
                    // override a non-zero class/mixed value.
                    const leftClass = km.getGlyphClass(left, 'left');
                    const rightClass = km.getGlyphClass(right, 'right');
                    let fallback = 0;
                    if (rightClass) fallback = km.getMixedPair('rightClass', rightClass, left);
                    if (fallback === 0 && leftClass) fallback = km.getMixedPair('leftClass', leftClass, right);
                    if (fallback === 0 && leftClass && rightClass) fallback = km.getClassValue(leftClass, rightClass);
                    if (fallback === 0) continue; // plain zero pair — drop it
                }
                kernDict.push(`    <key>${esc(left)}</key>`);
                kernDict.push('    <dict>');
                kernDict.push(`        <key>${esc(right)}</key>`);
                kernDict.push(`        <integer>${Math.round(value)}</integer>`);
                kernDict.push('    </dict>');
            }
            // Mixed pairs (class ↔ glyph): class side referenced by
            // public.kern1/public.kern2 key, glyph side by bare name —
            // the same shape FontForge writes and our importer reads.
            for (const { type, className, glyphName, value } of km.getAllMixedPairs()) {
                if (Math.round(value) === 0) {
                    // A zero mixed pair is only necessary when it overrides
                    // a non-zero class↔class value (glyph is in a class on
                    // the other side too).
                    let fallback = 0;
                    if (type === 'leftClass') {
                        const rightClass = km.getGlyphClass(glyphName, 'right');
                        if (rightClass) fallback = km.getClassValue(className, rightClass);
                    } else { // rightClass
                        const leftClass = km.getGlyphClass(glyphName, 'left');
                        if (leftClass) fallback = km.getClassValue(leftClass, className);
                    }
                    if (fallback === 0) continue;
                }
                if (type === 'leftClass') {
                    kernDict.push(`    <key>public.kern1.${esc(className)}</key>`);
                    kernDict.push('    <dict>');
                    kernDict.push(`        <key>${esc(glyphName)}</key>`);
                } else { // rightClass
                    kernDict.push(`    <key>${esc(glyphName)}</key>`);
                    kernDict.push('    <dict>');
                    kernDict.push(`        <key>public.kern2.${esc(className)}</key>`);
                }
                kernDict.push(`        <integer>${Math.round(value)}</integer>`);
                kernDict.push('    </dict>');
            }
            if (kernDict.length > 0) {
                ufoFolder.file("kerning.plist", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${kernDict.join('\n')}
</dict>
</plist>`);
            }
        }

        // ── Build ligature rules for features.fea ──
        // Multi-code-point charCode glyphs become liga substitution rules.
        // Rules are emitted longest-first (OpenType GSUB4 preference order:
        // within a ligature set the longest component sequence is tried
        // first, so "ffi" wins over "ff" at the same position).
        const ligatureRules = this._buildLigatureRules(
            c.curve_manager.treeItems, c.curve_manager.rootChildren || []);
        let feaContent = '# InkShader OpenType Feature File\n';
        if (ligatureRules.length > 0) {
            feaContent += '\nfeature liga {\n    lookup liga {\n';
            feaContent += ligatureRules.join('\n');
            feaContent += '\n    } liga;\n} liga;\n';
        }
        // Note: kerning data is exported ONLY to groups.plist + kerning.plist.
        // We do NOT write feature kern rules to features.fea to avoid double-application
        // (UFO readers apply both kerning.plist and fea kern rules, doubling values).
        ufoFolder.file("features.fea", feaContent);

        zip.generateAsync({ type: "blob" }).then((content) => {
            const url = c.env.createObjectURL(content);
            const a = c.env.createDOMElement("a");
            a.href = url;
            const dateStr = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
            a.download = `InkShader_export_${dateStr}.ufo.zip`;
            const bodyDOM = c.env.queryDOM("body");
            if (bodyDOM) {
                bodyDOM.appendChild(a);
                a.click();
                bodyDOM.removeChild(a);
            }
            c.env.revokeObjectURL(url);
        });
    }

    /**
     * Build ligature substitution rules for features.fea.
     * A glyph whose charCode is a multi-code-point string is a ligature
     * glyph; each component character must have its own single-char glyph.
     * Rules are returned longest-first (stable), which is the OpenType
     * GSUB4 preference order: ligatures are tried in array order within a
     * ligature set, so longer sequences must precede shorter prefixes
     * (e.g. "ffi" before "ff"), otherwise the shorter rule would consume
     * glyphs the longer rule needs.
     * @param {Map} treeItems - glyph id → tree item
     * @param {Array} rootChildren - root-level glyph ids (document order)
     * @returns {string[]} fea `sub ... by ...;` statements, longest-first
     */
    _buildLigatureRules(treeItems, rootChildren) {
        // Reverse lookup: single-code-point charCode → glyph name
        const charToGlyph = {};
        for (const cid of rootChildren) {
            const gi = treeItems.get(cid);
            if (!gi || gi.isRef || gi.charCode == null) continue;
            const chars = Array.from(String(gi.charCode));
            if (chars.length === 1) charToGlyph[chars[0]] = gi.name;
        }
        // fea has no escape mechanism for glyph names; only AFDKO-compatible
        // names can appear in `sub` statements.
        const isValidFeaName = (name) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name);
        const rules = [];
        for (const cid of rootChildren) {
            const gi = treeItems.get(cid);
            if (!gi || gi.isRef || gi.charCode == null) continue;
            const chars = Array.from(String(gi.charCode));
            if (chars.length < 2) continue;
            if (!isValidFeaName(gi.name)) {
                console.warn(`[UFO Export] Skipping ligature rule for "${gi.name}": glyph name is not valid in feature files.`);
                continue;
            }
            const input = chars.map(ch => charToGlyph[ch]);
            if (input.some(name => name === undefined)) {
                console.warn(`[UFO Export] Skipping ligature rule for "${gi.name}": some component characters have no glyph.`);
                continue;
            }
            rules.push({ seq: input, target: gi.name });
        }
        // Longest-first, stable: guarantees the longest match wins at any
        // position (greedy single-pass shaping, no backtracking).
        rules.sort((a, b) => b.seq.length - a.seq.length);
        return rules.map(r => `    sub ${r.seq.join(' ')} by ${r.target};`);
    }

    /**
     * Glyph ids in SVG document order: ligature glyphs (longer charCodes)
     * first, so a conforming renderer selects them before their components
     * (SVG 1.1: "the ffl ligature needs to be defined in the font before
     * the f glyph; otherwise the ffl will never be selected"). Stable:
     * equal charCode lengths keep tree order.
     * @param {Map} treeItems - glyph id → tree item
     * @param {Array} rootChildren - root-level glyph ids
     * @returns {Array} root glyph ids ordered for SVG output
     */
    _svgGlyphExportOrder(treeItems, rootChildren) {
        const cpLength = (item) => {
            if (!item || item.isRef || item.charCode == null) return 0;
            return Array.from(String(item.charCode)).length;
        };
        return rootChildren
            .filter(cid => {
                const item = treeItems.get(cid);
                return item && !item.isRef;
            })
            .sort((a, b) => cpLength(treeItems.get(b)) - cpLength(treeItems.get(a)));
    }

    // ── SVG Path Parser ──────────────────────────────────────────

    /**
     * Normalize an SVG path `d` attribute with the vendored `svgpath` library.
     *
     * The pipeline guarantees the produced segments contain ONLY:
     *   - `M` / `Z`  : subpath bookkeeping (kept as-is)
     *   - `C`        : cubic bézier (all other curve types promoted to cubic)
     *
     * Conversions applied (in order):
     *   `abs()`     → relative → absolute (incl. `M`→`L` implicit repetition)
     *   `unarc()`   → arc `A`→ cubic `C` (SVG F.6, kappa approximation)
     *   `unshort()` → smooth `S`→`C`, `T`→`Q`
     *   manual      → line `L`/`H`/`V` → degenerate cubic (endpoint controls)
     *              → quadratic `Q` → cubic via standard 2/3 promotion
     *              → any other segment (e.g. catmull-rom `R`) → DROPPED
     *
     * @param {string} dStr - SVG path d attribute
     * @returns {Array<{cmd:string, params:number[]}>} absolute M/C/Z segments
     */
    _normalizeSVGPathToCubics(dStr) {
        if (!dStr || !dStr.trim()) return [];
        const path = svgpath(dStr);
        if (path.err) return [];
        path.abs().unarc().unshort();

        const out = [];
        let cx = 0, cy = 0; // last absolute point, used by L/H/V/Q lowering

        for (const seg of path.segments) {
            const cmd = seg[0];
            switch (cmd) {
                case 'M':
                    [cx, cy] = [seg[1], seg[2]];
                    out.push({ cmd: 'M', params: [cx, cy] });
                    break;
                case 'C':
                    [cx, cy] = [seg[5], seg[6]];
                    out.push({ cmd: 'C', params: [seg[1], seg[2], seg[3], seg[4], cx, cy] });
                    break;
                case 'Q': {
                    // Quadratic → cubic: c1 = q0 + 2/3(q1-q0), c2 = q2 + 2/3(q1-q2)
                    const q1x = seg[1], q1y = seg[2], q2x = seg[3], q2y = seg[4];
                    const c1x = cx + (2 / 3) * (q1x - cx);
                    const c1y = cy + (2 / 3) * (q1y - cy);
                    const c2x = q2x + (2 / 3) * (q1x - q2x);
                    const c2y = q2y + (2 / 3) * (q1y - q2y);
                    cx = q2x; cy = q2y;
                    out.push({ cmd: 'C', params: [c1x, c1y, c2x, c2y, cx, cy] });
                    break;
                }
                case 'L': case 'H': case 'V': {
                    // Line → degenerate cubic (control points == endpoints),
                    // so node creation skips the redundant control handles.
                    let ex = cx, ey = cy;
                    if (cmd === 'L') { ex = seg[1]; ey = seg[2]; }
                    else if (cmd === 'H') { ex = seg[1]; }
                    else { ey = seg[1]; }
                    out.push({ cmd: 'C', params: [cx, cy, ex, ey, ex, ey] });
                    cx = ex; cy = ey;
                    break;
                }
                case 'Z':
                    out.push({ cmd: 'Z', params: [] });
                    break;
                default:
                    // Unconvertible command (e.g. catmull-rom `R`): dropped.
                    break;
            }
        }

        return out;
    }

    /**
     * Build InkShader Curve objects from parsed SVG path commands.
     * Uses the canvas CurveManager for curve/node creation.
     * @param {Array<{cmd:string, params:number[]}>} absCmds
     * @param {object} c - canvas object
     * @param {string|null} targetGroupId
     * @returns {string[]} array of created curve IDs
     */
    _svgAbsCmdsToCurves(absCmds, c, targetGroupId, canvasH) {
        if (!absCmds || absCmds.length === 0) return [];
        const createdCurveIds = [];
        // Full precision y-flip (NO Math.round) — must match the GLIF import
        // path (_parseGLIFContour flipY) and the SVG export's toFixed(5).
        // Rounding y to integers here injected 0.1-1.0° handle-direction
        // deviations on otherwise smooth points (error = 0.5/handleLength),
        // which the geometry classifier then read as corners (user case:
        // handles at -43.7°/136.4° are 0.1° off a mirror pair ONLY because
        // of this rounding).
        // canvasH is now the ascender value (baseline model Y)
        const flipY = canvasH != null ? (y) => canvasH - y : null;
        const fy = (y) => flipY ? flipY(y) : Math.round(y);

        // Group commands into subpaths (each M starts a new subpath)
        let i = 0;
        while (i < absCmds.length) {
            // Skip to the next M command
            while (i < absCmds.length && absCmds[i].cmd !== 'M') i++;
            if (i >= absCmds.length) break;
            const mx = absCmds[i].params[0];
            const my = fy(absCmds[i].params[1]);
            i++; // consume the M command

            // Collect all commands for this subpath
            const segs = [];
            let closed = false;
            while (i < absCmds.length && absCmds[i].cmd !== 'M') {
                if (absCmds[i].cmd === 'Z') {
                    closed = true;
                    i++;
                    break;
                }
                segs.push(absCmds[i]);
                i++;
            }

            if (segs.length === 0 && !closed) continue;

            // Create the curve
            const curve = c.curve_manager.create_temp_curve();
            curve.closed = closed;
            curve.stroke_width = 0;
            curve.smart_stroke = false; // imported paths are raw geometry

            let lastMarker = null;
            let firstNodeMarker = null;

            // Add the initial M point as the first vertex
            const mMarker = generateMarker("vertex");
            c.curve_manager.add_node_by_curve(
                mMarker, "vertex", mx, my,
                null, null, curve, String(mMarker.id)
            );
            firstNodeMarker = mMarker;
            lastMarker = mMarker;

            for (const seg of segs) {
                if (seg.cmd === 'L') {
                    const mainMarker = generateMarker("vertex");
                    c.curve_manager.add_node_by_curve(
                        mainMarker, "vertex", seg.params[0], fy(seg.params[1]),
                        null, lastMarker, curve, String(mainMarker.id)
                    );
                    if (!firstNodeMarker) firstNodeMarker = mainMarker;
                    lastMarker = mainMarker;
                } else if (seg.cmd === 'C') {
                    const [c1x, c1y, c2x, c2y, ex, ey] = seg.params;
                    // SVG C cmd ordering matches getSkeletonBezierSegments:
                    //   p1 = prevNode.control1, p2 = node.control2
                    // so (c1x,c1y)→prevNode.control1, (c2x,c2y)→node.control2
                    // First, set previous node's control1 (first BCP) if meaningful
                    if (lastMarker) {
                        const prevNode = c.curve_manager.curveStore.find_node_by_curve(lastMarker);
                        if (prevNode && (prevNode.x !== c1x || prevNode.y !== fy(c1y))) {
                            const c1Marker = generateMarker("circle");
                            const c1Node = new CurveNode(c1Marker, null, c1x, fy(c1y), prevNode, null, String(c1Marker.id));
                            c1Node.curve = curve;
                            prevNode.control1 = c1Node;
                            curve.domMap.set(c1Marker, c1Node);
                            c.curve_manager.domMap.set(c1Marker, c1Node);
                        }
                    }
                    // Create end node with applied Y-flip
                    const mainMarker = generateMarker("vertex");
                    c.curve_manager.add_node_by_curve(
                        mainMarker, "vertex", ex, fy(ey),
                        null, lastMarker, curve, String(mainMarker.id)
                    );
                    if (!firstNodeMarker) firstNodeMarker = mainMarker;

                    // Set end node's control2 (second BCP) if meaningful
                    const node = c.curve_manager.curveStore.find_node_by_curve(mainMarker);
                    if (node && (node.x !== c2x || node.y !== fy(c2y))) {
                        const c2Marker = generateMarker("circle");
                        const c2Node = new CurveNode(c2Marker, null, c2x, fy(c2y), node, null, String(c2Marker.id));
                        c2Node.curve = curve;
                        node.control2 = c2Node;
                        curve.domMap.set(c2Marker, c2Node);
                        c.curve_manager.domMap.set(c2Marker, c2Node);
                    }
                    lastMarker = mainMarker;
                }
            }

            // Classify control_mode from geometry AFTER all handles are attached:
            // a node's control1 comes from the NEXT segment's C command, its
            // control2 from its own. CurveNode defaults to control_mode=2
            // (symmetric), which would corrupt asymmetric handles on later edits.
            this._finalizeImportedControlModes(curve);

            c.curve_manager.addPath(curve, targetGroupId);
            createdCurveIds.push(curve.id);
        }

        return createdCurveIds;
    }

    /**
     * Parse an SVG path `d` attribute string into InkShader curves
     * and commit them to a target group.
     * @param {string} dStr - SVG path d attribute
     * @param {object} canvas
     * @param {string|null} targetGroupId
     * @returns {string[]} created curve IDs
     */
    _parseSVGPathToCurves(dStr, c, targetGroupId, canvasH) {
        const absCmds = this._normalizeSVGPathToCubics(dStr);
        if (absCmds.length === 0) return [];
        return this._svgAbsCmdsToCurves(absCmds, c, targetGroupId, canvasH);
    }

    // ── SVG Image Import ─────────────────────────────────────────

    triggerImportSVGAsImage() {
        const c = this.canvas;
        const input = c.env.createDOMElement("input");
        input.type = "file";
        input.accept = ".svg";
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                const svgText = event.target.result;
                this._importSVGImageFromString(svgText, file.name);
            };
            reader.readAsText(file);
        };
        input.click();
    }

    _importSVGImageFromString(svgText, fileName) {
        const c = this.canvas;
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, 'image/svg+xml');

        // Find all <path> elements NOT inside <defs>
        const allPaths = doc.querySelectorAll('path');
        const targetId = c.curve_manager.ensureActiveGroup();
        if (!targetId) return false;

        let curveCount = 0;
        for (const pathEl of allPaths) {
            // Skip paths inside <defs>
            let parent = pathEl.parentElement;
            let inDefs = false;
            while (parent) {
                if (parent.tagName.toLowerCase() === 'defs') { inDefs = true; break; }
                parent = parent.parentElement;
            }
            if (inDefs) continue;

            const d = pathEl.getAttribute('d');
            if (!d) continue;

            const ids = this._parseSVGPathToCurves(d, c, targetId);
            curveCount += ids.length;
        }

        if (curveCount > 0) {
            c.is_dirty = true;
        }
        return curveCount > 0;
    }

    /**
     * Auto-detect SVG type and route to the correct import.
     * If the SVG contains a <font> element in <defs>, import as font project.
     * Otherwise, import visual path layers as curves into the active group.
     */
    triggerImportSVGAuto() {
        const c = this.canvas;
        const input = c.env.createDOMElement("input");
        input.type = "file";
        input.accept = ".svg";
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                const svgText = event.target.result;
                // Quick check: does it contain a <font> element?
                if (/<font[\s>]/i.test(svgText) && /<glyph[\s>]/i.test(svgText)) {
                    await this._importSVGFontFromString(svgText);
                } else {
                    this._importSVGImageFromString(svgText, file.name);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    // ── SVG Font Import ──────────────────────────────────────────

    triggerImportSVGAsFont() {
        const c = this.canvas;
        const input = c.env.createDOMElement("input");
        input.type = "file";
        input.accept = ".svg";
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                const svgText = event.target.result;
                await this._importSVGFontFromString(svgText);
            };
            reader.readAsText(file);
        };
        input.click();
    }

    async _importSVGFontFromString(svgText) {
        const c = this.canvas;
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgText, 'image/svg+xml');

        const fontEl = doc.querySelector('font');
        if (!fontEl) {
            alert('No <font> element found in the SVG file.');
            return false;
        }

        // Extract font-face metadata. cap-height / x-height are OPTIONAL in SVG fonts —
        // a missing attribute must fall back to the OpenType-typical ratios (0.7em / 0.5em),
        // NOT 0: writing 0 into the imported project silently corrupts the file's cap height
        // (persisted by save/load as an explicit 0; only an import can manufacture that 0).
        const faceEl = fontEl.querySelector('font-face');
        const upm = parseInt(faceEl?.getAttribute('units-per-em'), 10) || 1000;
        const family = faceEl?.getAttribute('font-family') || 'Imported Font';
        const ascender = parseInt(faceEl?.getAttribute('ascent'), 10) || 800;
        const descender = parseInt(faceEl?.getAttribute('descent'), 10) || -200;
        const capHeight = parseInt(faceEl?.getAttribute('cap-height'), 10) || Math.round(upm * 0.7);
        const xHeight = parseInt(faceEl?.getAttribute('x-height'), 10) || Math.round(upm * 0.5);

        // Find all glyph elements
        const glyphs = fontEl.querySelectorAll('glyph');
        if (glyphs.length === 0) {
            alert('No <glyph> elements found in the SVG font.');
            return false;
        }

        // Determine project name: custom InkShader field > font family > default
        const rootEl = doc.querySelector('svg');
        const svgProjectName = rootEl?.getAttribute('data-project-name')?.trim();
        const projectName = svgProjectName || family || "Imported SVG Font";

        // Save current project before switching (same as loadFromFile)
        const pm = c.projectManager;
        if (pm?.activeProjectName) {
            await pm.saveToCache(pm.activeProjectName);
        }

        // Check cache for duplicate project name (same pattern as loadFromFile)
        if (await StorageUtils.projectExists(projectName)) {
            const msg = `Project "${projectName}" already exists in cache. Overwrite?`;
            if (!confirm(msg)) {
                return false; // User cancelled
            }
            await StorageUtils.deleteProject(projectName);
        }

        // Reset canvas via empty snapshot (create a fresh independent project)
        const emptySnapshot = JSON.stringify({
            version: "1.0",
            editor_guidelines: [],
            editor_sequence: "", editor_active_indices: [],
            family_name: family,
            project_name: projectName,
            // Canvas size = em box in design units; matches the UPM read from
            // the SVG font so metric lines and exports stay consistent.
            canvas_size_width: upm,
            canvas_size_height: upm,
            basic_spacing: upm,
            font_style: "Regular",
            postscript_name: "",
            preferred_family: "",
            preferred_subfamily: "",
            copyright: "",
            designer: "",
            designer_url: "",
            manufacturer: "",
            manufacturer_url: "",
            license: "",
            license_url: "",
            trademark: "",
            description: "",
            sample_text: "",
            upm: upm,
            weight_class: 400,
            width_class: 5,
            ascender: ascender,
            descender: descender,
            x_height: xHeight,
            cap_height: capHeight,
            font_version: "1.0",
            editor_root_order: [],
            glyphs: {}
        });
        await c.commands.loadSnapshotCommand(emptySnapshot);
        c.commandStack = [];
        c.redoCommandStack = [];
        // Clear stale selection state (same pattern as loadFromFile in ProjectManager)
        c.curve_manager.clearAllSelection();
        c.curve_manager.activeGroupId = null;

        // Import SVG glyphs
        let glyphCount = 0;
        const pendingRefs = []; // { groupId, refs } — resolved after all glyphs exist
        for (const glyphEl of glyphs) {
            const glyphName = glyphEl.getAttribute('glyph-name') || `glyph_${glyphCount}`;
            const unicode = glyphEl.getAttribute('unicode') || null;
            const advance = parseFloat(glyphEl.getAttribute('horiz-adv-x')) || upm;
            const d = glyphEl.getAttribute('d');

            // Create root-level group
            const groupId = glyphName;
            c.curve_manager.treeStore.treeItems.set(groupId, {
                id: groupId, type: 'group', name: glyphName,
                charCode: unicode || null, parentId: null,
                children: [], isRef: false, refId: null, collapsed: false,
                // hidden_by_sequence: the sequence is empty on import, so
                // glyphs are hidden from the moment they are created — a
                // mid-import render (commit_curve → notifyTreeUpdate, async
                // glyph loop) must not flash them in the object tree.
                hidden_by_sequence: true,
                // is_modified: imported glyphs must survive cleanup
                // (cleanupUnusedEmptyGroups / syncTreeWithSequence delete
                // empty, unmodified, non-sequenced root groups).
                is_modified: true,
                advance: advance
            });
            c.curve_manager.rootChildren.push(groupId);

            // Empty/missing d is valid: empty glyphs (ligature placeholders
            // like A_D, unicode-only glyphs like G) must survive round-trip.
            if (d) {
                // Parse path data into curves within this group (Y-flip to match UFO-style Y-up coords)
                this._parseSVGPathToCurves(d, c, groupId, c.fontSettings?.ascender ?? 800);
            }

            // data-refs: component references written by our own exportToSVG.
            // Deferred like UFO <component> handling — the base glyph may
            // appear later in the document.
            const refsAttr = glyphEl.getAttribute('data-refs');
            if (refsAttr) {
                let refs = [];
                try {
                    refs = JSON.parse(refsAttr);
                    if (!Array.isArray(refs)) refs = [];
                } catch (err) {
                    console.warn(`[SVG Font Import] Invalid data-refs on glyph "${glyphName}":`, err);
                    refs = [];
                }
                if (refs.length > 0) pendingRefs.push({ groupId, refs });
            }
            glyphCount++;
        }

        if (glyphCount > 0) {
            // ── Initialize sequence state after importing glyphs ──
            // The canvas sequence is LEFT EMPTY on import: importing a
            // font must NOT populate the sequence with every glyph. The
            // user adds glyphs to the sequence as needed. Root groups not
            // in the (empty) sequence are hidden by the final tree sync
            // below (no ghost objects in the object tree); all imported
            // groups survive cleanup via is_modified: true (set on each
            // group during creation).
            const seqService = c.curve_manager.seqService;
            seqService.sequenceText = '';
            seqService._prevInTextIds = null;   // Force full sweep on next syncTreeWithSequence
            seqService.rebuildDefaultGlyphs();

            // Resolve data-refs now that every glyph group exists AND the
            // sequence state is initialized (same two-phase pattern as UFO
            // <component> import). The refs must be pasted BEFORE the final
            // updateSequenceParsing below: a glyph whose only geometry is a
            // ref (e.g. test1) would otherwise be seen as empty and cleaned
            // up by cleanupUnusedEmptyGroups.
            for (const { groupId, refs } of pendingRefs) {
                for (const ref of refs) {
                    const target = c.curve_manager.getGroupByName(ref.base);
                    if (!target || !Array.isArray(ref.m) || ref.m.length !== 6) continue;
                    c.curve_manager.pasteGroupRef(target.id, groupId, new DOMMatrix(ref.m), ref.name || null);
                }
            }

            // Final sequence parse (empty sequence: cleanup must not delete
            // imported glyphs — all imported groups carry is_modified: true;
            // ref-only glyphs already have their refs).
            seqService.updateSequenceParsing();

            // Full tree sync (same invariant as JSON load): _prevInTextIds
            // was reset above, so syncTreeWithSequence performs a full sweep
            // and hides every root group not in the (empty) sequence — no
            // ghost objects in the object tree. Imported groups carry
            // is_modified: true, so they are hidden, never deleted.
            seqService.syncTreeWithSequence(null, null, null, () => c.curve_manager.notifyTreeUpdate());

            // Activate all sequence positions (all imported glyphs should be active)
            seqService.setActiveIndices(new Set(seqService.sequenceTokens.map((_, i) => i)));

            c.curve_manager.notifyTreeUpdate();
            // Seed editor store with imported glyphs (like loadFromFile does after snapshot load)
            c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
            c.bumpEditorStoreTreeRevision?.();
            c.is_dirty = true;
        }

        // History baseline: capture the FULLY imported document (not the
        // empty reset snapshot above). Without this refresh, the first
        // command recorded after import (e.g. adding a sequence glyph)
        // diffs against an empty baseline — undo would wipe the project.
        c.currentStateObj = c.history.getHistoryState();

        // Register project with ProjectManager (like loadFromFile does)
        if (pm && glyphCount > 0) {
            pm.setActiveProjectName(projectName);
            if (typeof c.history._flushRuntimeStateSave === "function") c.history._flushRuntimeStateSave();
            c.history.saveCurrentViewState(true);
            c.notifyPropertiesUpdate();
            await pm.saveToCache(projectName);
        }

        return glyphCount > 0;
    }

    // ── UFO Import ───────────────────────────────────────────────

    triggerImportUFO() {
        const c = this.canvas;
        if (typeof JSZip === "undefined") {
            alert("JSZip library is not loaded. Cannot import UFO.");
            return;
        }
        const input = c.env.createDOMElement("input");
        input.type = "file";
        input.accept = ".zip,.ufo";
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const zip = await JSZip.loadAsync(event.target.result);
                    await this._importUFOFromZip(zip);
                } catch (err) {
                    console.error("[UFO Import] Error:", err);
                    alert("Failed to import UFO: " + err.message);
                }
            };
            reader.readAsArrayBuffer(file);
        };
        input.click();
    }

    async _importUFOFromZip(zip) {
        const c = this.canvas;

        // 1. Parse fontinfo.plist
        const fiStr = zip.file("font.ufo/fontinfo.plist")?.async?.("string")
            || zip.file("fontinfo.plist")?.async?.("string");
        if (!fiStr) {
            alert("Invalid UFO: missing fontinfo.plist");
            return false;
        }
        const fiText = await fiStr;
        const fontSettings = this._parseUFOFontInfo(fiText);

        // 2. Get glyph → file mapping from contents.plist
        const contentsStr = zip.file("font.ufo/glyphs/contents.plist")?.async?.("string")
            || zip.file("glyphs/contents.plist")?.async?.("string");
        if (!contentsStr) {
            alert("Invalid UFO: missing glyphs/contents.plist");
            return false;
        }
        const contentsText = await contentsStr;
        const glyphMap = this._parseUFOContents(contentsText);

        // 3. Determine project name from UFO metadata (like loadFromFile uses project_name)
        // Priority: custom InkShader project_name → familyName → postscriptFontName → default
        const projectName = fontSettings.project_name?.trim()
            || fontSettings.family?.trim()
            || fontSettings.postscript_name?.trim()
            || "Imported UFO Font";

        // 4. Save current project before switching (same as loadFromFile)
        const pm = c.projectManager;
        if (pm?.activeProjectName) {
            await pm.saveToCache(pm.activeProjectName);
        }

        // 5. Check cache for duplicate project name (same pattern as loadFromFile)
        if (await StorageUtils.projectExists(projectName)) {
            const msg = `Project "${projectName}" already exists in cache. Overwrite?`;
            if (!confirm(msg)) {
                return false; // User cancelled
            }
            await StorageUtils.deleteProject(projectName);
        }

        // 5. Reset canvas via empty snapshot (create a fresh independent project)
        const emptySnapshot = JSON.stringify({
            version: "1.0",
            // UFO fontinfo guidelines (Y-up) flipped into canvas space
            // (Y-down) so they round-trip with exportToUFO
            editor_guidelines: (fontSettings.guidelines || []).map(g => ({
                x: g.x,
                // Flip against the ascender: model Y = ascender - fontY
                y: (fontSettings.ascender ?? 800) - g.y,
                ...(g.angle ? { angle: g.angle } : {})
            })),
            editor_sequence: "", editor_active_indices: [],
            family_name: fontSettings.family || "InkShader_Default_Font",
            project_name: projectName,
            // Canvas size = em box in design units; tracks the imported UPM so
            // re-export flips and metric lines stay consistent.
            canvas_size_width: fontSettings.upm || 1000,
            canvas_size_height: fontSettings.upm || 1000,
            basic_spacing: fontSettings.upm || 1000,
            font_style: fontSettings.style || "Regular",
            postscript_name: fontSettings.postscript_name || "",
            preferred_family: fontSettings.preferred_family || "",
            preferred_subfamily: fontSettings.preferred_subfamily || "",
            copyright: fontSettings.copyright || "",
            designer: fontSettings.designer || "",
            designer_url: fontSettings.designer_url || "",
            manufacturer: fontSettings.manufacturer || "",
            manufacturer_url: fontSettings.manufacturer_url || "",
            license: fontSettings.license || "",
            license_url: fontSettings.license_url || "",
            trademark: fontSettings.trademark || "",
            description: fontSettings.description || "",
            sample_text: fontSettings.sample_text || "",
            upm: fontSettings.upm || 1000,
            weight_class: fontSettings.weight_class || 400,
            width_class: fontSettings.width_class || 5,
            ascender: fontSettings.ascender || 800,
            descender: fontSettings.descender != null ? fontSettings.descender : -200,
            x_height: fontSettings.x_height != null ? fontSettings.x_height : 500,
            cap_height: fontSettings.cap_height != null ? fontSettings.cap_height : 700,
            font_version: fontSettings.version || "1.0",
            editor_root_order: [],
            glyphs: {}
        });
        await c.commands.loadSnapshotCommand(emptySnapshot);
        c.commandStack = [];
        c.redoCommandStack = [];
        // Clear stale selection state (same pattern as loadFromFile in ProjectManager)
        c.curve_manager.clearAllSelection();
        c.curve_manager.activeGroupId = null;

        // 6. Import UFO glyphs (phase 1: outlines + unicode + advance;
        // components are deferred to phase 2 below so base glyphs resolve
        // regardless of contents.plist order)
        const glyphNames = Object.keys(glyphMap);
        let glyphCount = 0;
        const pendingComponents = []; // { components, groupId }

        for (const glyphName of glyphNames) {
            const fileName = glyphMap[glyphName];
            const glifFile = zip.file(`font.ufo/glyphs/${fileName}`)
                || zip.file(`glyphs/${fileName}`);
            if (!glifFile) continue;

            const glifText = await glifFile.async("string");
            const result = this._importGLIF(glifText, glyphName, c);
            if (result) {
                glyphCount++;
                if (result.components?.length > 0) {
                    pendingComponents.push({ components: result.components, groupId: result.groupId });
                }
            }
        }

        // 6b. Import kerning (groups.plist + kerning.plist) and ligature
        // rules (features.fea). Runs AFTER glyph import (glyph-name
        // validation + charCode lookups) and BEFORE the sequence rebuild
        // below so imported ligature charCodes are registered.
        await this._importUFOKerningAndLigatures(zip, c);

        if (glyphCount > 0) {
            // ── Initialize sequence state after importing glyphs ──
            // The canvas sequence is LEFT EMPTY on import: importing a
            // font must NOT populate the sequence with every glyph. The
            // user adds glyphs to the sequence as needed. Root groups not
            // in the (empty) sequence are hidden by the final tree sync
            // below (no ghost objects in the object tree); all imported
            // groups survive cleanup via is_modified: true (set on each
            // group during creation).
            const seqService = c.curve_manager.seqService;
            seqService.sequenceText = '';
            seqService._prevInTextIds = null;   // Force full sweep on next syncTreeWithSequence
            seqService.rebuildDefaultGlyphs();

            // 6a. Resolve <component> references now that every glyph exists
            // AND the sequence state is initialized. The refs must be pasted
            // BEFORE the final updateSequenceParsing below: a glyph whose
            // only geometry is a component (e.g. test1) would otherwise be
            // seen as empty and cleaned up by cleanupUnusedEmptyGroups.
            for (const { components, groupId } of pendingComponents) {
                this._applyGLIFComponents(components, c, groupId);
            }

            // Final sequence parse (empty sequence: cleanup must not delete
            // imported glyphs — all imported groups carry is_modified: true;
            // ref-only glyphs already have their refs).
            seqService.updateSequenceParsing();

            // Full tree sync (same invariant as JSON load): _prevInTextIds
            // was reset above, so syncTreeWithSequence performs a full sweep
            // and hides every root group not in the (empty) sequence — no
            // ghost objects in the object tree. Imported groups carry
            // is_modified: true, so they are hidden, never deleted.
            seqService.syncTreeWithSequence(null, null, null, () => c.curve_manager.notifyTreeUpdate());

            // Activate all sequence positions (all imported glyphs should be active)
            seqService.setActiveIndices(new Set(seqService.sequenceTokens.map((_, i) => i)));

            c.curve_manager.notifyTreeUpdate();
            // Seed editor store with imported glyphs (like loadFromFile does after snapshot load)
            c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
            c.bumpEditorStoreTreeRevision?.();
            c.is_dirty = true;
        }

        // History baseline: capture the FULLY imported document (not the
        // empty reset snapshot above). Without this refresh, the first
        // command recorded after import (e.g. adding a sequence glyph)
        // diffs against an empty baseline — undo would wipe the project.
        c.currentStateObj = c.history.getHistoryState();

        // 7. Register project with ProjectManager (like loadFromFile does)
        if (pm && glyphCount > 0) {
            pm.setActiveProjectName(projectName);
            if (typeof c.history._flushRuntimeStateSave === "function") c.history._flushRuntimeStateSave();
            c.history.saveCurrentViewState(true);
            c.notifyPropertiesUpdate();
            await pm.saveToCache(projectName);
        }

        if (glyphCount === 0) {
            alert("No valid glyphs found in the UFO file.");
        }
        return glyphCount > 0;
    }

    /**
     * Parse UFO fontinfo.plist XML into font settings object.
     * UFO fontinfo is not strictly typed: numeric keys may appear as
     * <integer> or <real> depending on the producing tool (FontForge
     * writes <real> for values like 800.0). String values are XML-escaped.
     */
    _parseUFOFontInfo(xmlText) {
        const settings = {};
        const unesc = (s) => this._unescapeXml(s);
        const kvMatch = (re, key, transform = v => v) => {
            const m = xmlText.match(re);
            if (m) settings[key] = transform(m[1]);
        };
        // Numeric keys: accept <integer> OR <real> (UFO spec is loose here)
        const num = (re, key) => kvMatch(re, key, v => parseFloat(v));
        const numInt = (re, key) => kvMatch(re, key, v => parseInt(v, 10));
        const str = (re, key) => kvMatch(re, key, unesc);

        str(/<key>familyName<\/key>\s*<string>([^<]*)<\/string>/, 'family');
        str(/<key>styleName<\/key>\s*<string>([^<]*)<\/string>/, 'style');
        num(/<key>unitsPerEm<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/, 'upm');
        num(/<key>ascender<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/, 'ascender');
        num(/<key>descender<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/, 'descender');
        num(/<key>capHeight<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/, 'cap_height');
        num(/<key>xHeight<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/, 'x_height');
        str(/<key>copyright<\/key>\s*<string>([^<]*)<\/string>/, 'copyright');
        str(/<key>postscriptFontName<\/key>\s*<string>([^<]*)<\/string>/, 'postscript_name');
        numInt(/<key>versionMajor<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/, 'versionMajor');
        numInt(/<key>versionMinor<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/, 'versionMinor');
        str(/<key>openTypeNameDesigner<\/key>\s*<string>([^<]*)<\/string>/, 'designer');
        str(/<key>openTypeNameDesignerURL<\/key>\s*<string>([^<]*)<\/string>/, 'designer_url');
        str(/<key>openTypeNameManufacturer<\/key>\s*<string>([^<]*)<\/string>/, 'manufacturer');
        str(/<key>openTypeNameManufacturerURL<\/key>\s*<string>([^<]*)<\/string>/, 'manufacturer_url');
        str(/<key>openTypeNameLicense<\/key>\s*<string>([^<]*)<\/string>/, 'license');
        str(/<key>openTypeNameLicenseURL<\/key>\s*<string>([^<]*)<\/string>/, 'license_url');
        str(/<key>openTypeNameVersion<\/key>\s*<string>([^<]*)<\/string>/, 'version');
        str(/<key>openTypeNameDescription<\/key>\s*<string>([^<]*)<\/string>/, 'description');
        str(/<key>openTypeNameSampleText<\/key>\s*<string>([^<]*)<\/string>/, 'sample_text');
        str(/<key>openTypeNamePreferredFamilyName<\/key>\s*<string>([^<]*)<\/string>/, 'preferred_family');
        str(/<key>openTypeNamePreferredSubfamilyName<\/key>\s*<string>([^<]*)<\/string>/, 'preferred_subfamily');
        str(/<key>styleMapFamilyName<\/key>\s*<string>([^<]*)<\/string>/, 'style_map_family');
        num(/<key>italicAngle<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/, 'italic_angle');
        num(/<key>openTypeOS2WeightClass<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/, 'weight_class');
        num(/<key>openTypeOS2WidthClass<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/, 'width_class');
        str(/<key>trademark<\/key>\s*<string>([^<]*)<\/string>/, 'trademark');
        // Custom InkShader field: preserve project_name through round-trip
        str(/<key>com\.inkshader\.projectName<\/key>\s*<string>([^<]*)<\/string>/, 'project_name');

        // Guidelines array (list of dicts with x, y, optional angle — the
        // same shape exportToUFO writes). Values may be integer or real.
        const guidelines = [];
        const gArrMatch = xmlText.match(/<key>guidelines<\/key>\s*<array>([\s\S]*?)<\/array>/);
        if (gArrMatch) {
            const gDictRe = /<dict>([\s\S]*?)<\/dict>/g;
            let gm;
            while ((gm = gDictRe.exec(gArrMatch[1])) !== null) {
                const gx = gm[1].match(/<key>x<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/);
                const gy = gm[1].match(/<key>y<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/);
                if (gx && gy) {
                    const g = { x: parseFloat(gx[1]), y: parseFloat(gy[1]) };
                    const ga = gm[1].match(/<key>angle<\/key>\s*<(?:integer|real)>([^<]*)<\/(?:integer|real)>/);
                    if (ga) g.angle = parseFloat(ga[1]);
                    guidelines.push(g);
                }
            }
        }
        settings.guidelines = guidelines;

        return settings;
    }

    /**
     * Parse UFO contents.plist → glyph name → filename mapping.
     * Both names and filenames are XML-escaped in plist files, so decode
     * entities (glyph "A&B" is stored as key "A&amp;B").
     */
    _parseUFOContents(xmlText) {
        const map = {};
        const re = /<key>\s*([^<]+?)\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/g;
        let m;
        while ((m = re.exec(xmlText)) !== null) {
            map[this._unescapeXml(m[1])] = this._unescapeXml(m[2]);
        }
        return map;
    }

    // ── UFO kerning + ligature import ──────────────────────────────

    /**
     * Import kerning (groups.plist + kerning.plist) and ligature rules
     * (features.fea) from a UFO zip. Runs AFTER glyph import (so glyph
     * names exist) and BEFORE the sequence rebuild (so ligature charCodes
     * are picked up by rebuildDefaultGlyphs).
     */
    async _importUFOKerningAndLigatures(zip, c) {
        const km = c.curve_manager?.kerningManager;
        const groupsStr = zip.file("font.ufo/groups.plist")?.async?.("string")
            || zip.file("groups.plist")?.async?.("string");
        const kernStr = zip.file("font.ufo/kerning.plist")?.async?.("string")
            || zip.file("kerning.plist")?.async?.("string");
        const feaStr = zip.file("font.ufo/features.fea")?.async?.("string")
            || zip.file("features.fea")?.async?.("string");

        if (km && (groupsStr || kernStr)) {
            const groupsText = groupsStr ? await groupsStr : null;
            const kernText = kernStr ? await kernStr : null;
            this._applyUFOKerning(km, c, groupsText, kernText);
        }
        if (feaStr) {
            const feaText = await feaStr;
            this._applyLigaRulesFromFea(feaText, c);
        }
    }

    /**
     * Apply parsed UFO kerning data to the KerningManager.
     * Pairs referencing glyphs that were not imported are dropped.
     */
    _applyUFOKerning(km, c, groupsText, kernText) {
        const existing = new Set();
        for (const [id, item] of c.curve_manager.treeItems) {
            if (item.type === 'group' && item.parentId === null && !item.isRef) existing.add(item.name);
        }
        if (groupsText) {
            const { left, right } = this._parseUFOGroupsPlist(groupsText, existing);
            for (const [name, members] of Object.entries(left)) km.setClass('left', name, members);
            for (const [name, members] of Object.entries(right)) km.setClass('right', name, members);
        }
        if (kernText) {
            const { classValues, pairs, mixed } = this._parseUFOKerningPlist(kernText, existing);
            for (const { leftClass, rightClass, value } of classValues) km.setClassValue(leftClass, rightClass, value);
            for (const { left, right, value } of pairs) km.setPair(left, right, value);
            for (const { type, className, glyphName, value } of mixed) km.setMixedPair(type, className, glyphName, value);
        }
    }

    /**
     * Parse UFO groups.plist → kerning classes.
     * Standard UFO3 keys: public.kern1.{name} (left), public.kern2.{name} (right).
     * Members not present in the imported glyph set are dropped.
     * @returns {{left: Object<string, string[]>, right: Object<string, string[]>}}
     */
    _parseUFOGroupsPlist(xmlText, existing) {
        const left = {};
        const right = {};
        const classRe = /<key>\s*(public\.kern([12])\.([^<]+?))\s*<\/key>\s*<array>([\s\S]*?)<\/array>/g;
        let m;
        while ((m = classRe.exec(xmlText)) !== null) {
            const side = m[2] === '1' ? 'left' : 'right';
            const className = this._unescapeXml(m[3]);
            const members = [];
            const stringRe = /<string>\s*([^<]*?)\s*<\/string>/g;
            let sm;
            while ((sm = stringRe.exec(m[4])) !== null) {
                const name = this._unescapeXml(sm[1]);
                if (name && existing.has(name)) members.push(name);
            }
            if (members.length > 0) (side === 'left' ? left : right)[className] = members;
        }
        return { left, right };
    }

    /**
     * Parse UFO kerning.plist → class values, exact pairs, mixed pairs.
     * @returns {{classValues: Array, pairs: Array, mixed: Array}}
     */
    _parseUFOKerningPlist(xmlText, existing) {
        const classValues = [];
        const pairs = [];
        const mixed = [];
        const entryRe = /<key>\s*([^<]+?)\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
        let m;
        while ((m = entryRe.exec(xmlText)) !== null) {
            const leftKey = this._unescapeXml(m[1]);
            const leftIsClass = leftKey.startsWith('public.kern1.');
            const leftName = leftIsClass ? leftKey.slice('public.kern1.'.length) : leftKey;
            const innerRe = /<key>\s*([^<]+?)\s*<\/key>\s*<(?:integer|real)>\s*(-?[\d.]+)\s*<\/(?:integer|real)>/g;
            let im;
            while ((im = innerRe.exec(m[2])) !== null) {
                const rightKey = this._unescapeXml(im[1]);
                const value = parseFloat(im[2]);
                if (!Number.isFinite(value)) continue;
                const rightIsClass = rightKey.startsWith('public.kern2.');
                const rightName = rightIsClass ? rightKey.slice('public.kern2.'.length) : rightKey;
                if (leftIsClass && rightIsClass) {
                    classValues.push({ leftClass: leftName, rightClass: rightName, value });
                } else if (leftIsClass && !rightIsClass) {
                    if (existing.has(rightName)) mixed.push({ type: 'leftClass', className: leftName, glyphName: rightName, value });
                } else if (!leftIsClass && rightIsClass) {
                    if (existing.has(leftName)) mixed.push({ type: 'rightClass', className: rightName, glyphName: leftName, value });
                } else {
                    if (existing.has(leftName) && existing.has(rightName)) pairs.push({ left: leftName, right: rightName, value });
                }
            }
        }
        return { classValues, pairs, mixed };
    }

    /**
     * Conservative features.fea ligature importer.
     *
     * Only rules that are fully understood are applied: plain
     * `sub <glyph>+ by <glyph>;` statements inside `feature liga { ... } liga;`
     * blocks (the exact shape our own export produces, with or without a
     * `lookup ... { ... } ...;` wrapper). Any construct outside that shape
     * (classes `[...]`, class refs `@x`, apostrophe marks `'`, ignore rules,
     * rsub/reversesub, subtable, quoted glyph names) causes the whole block
     * to be skipped — never guessed. Restores charCode for ligature glyphs
     * whose GLIF has no <unicode>, enabling UFO round-trip.
     */
    _applyLigaRulesFromFea(feaText, c) {
        const treeItems = c.curve_manager.treeItems;
        if (!treeItems || treeItems.size === 0) return;
        // name → item and name → single codepoint char (components must be single chars)
        const itemByName = new Map();
        const charOf = new Map();
        for (const [id, item] of treeItems) {
            if (item.type === 'group' && item.parentId === null && !item.isRef) {
                itemByName.set(item.name, item);
                if (item.charCode != null) {
                    const chars = Array.from(String(item.charCode));
                    if (chars.length === 1) charOf.set(item.name, chars[0]);
                }
            }
        }
        const blockRe = /feature\s+liga\s*\{([\s\S]*?)\}\s*liga\s*;/g;
        const ruleRe = /\bsub\s+([A-Za-z_][A-Za-z0-9_.]*(?:\s+[A-Za-z_][A-Za-z0-9_.]*)+)\s+by\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/g;
        let block;
        while ((block = blockRe.exec(feaText)) !== null) {
            let body = block[1];
            // Strip comments
            body = body.replace(/#[^\n]*/g, '');
            // Conservative: skip blocks containing constructs we don't handle.
            // NOTE: `to` is deliberately NOT skipped — "to" is a common
            // ligature target glyph name (e.g. `sub t o by to;`).
            if (/[\[\]@'"\\]|ignore|rsub|reversesub|subtable|from/.test(body)) continue;
            let m;
            while ((m = ruleRe.exec(body)) !== null) {
                const inputs = m[1].split(/\s+/);
                const targetName = m[2];
                if (inputs.length < 2) continue;
                // Every input glyph must map to exactly one codepoint
                let seq = '';
                let ok = true;
                for (const name of inputs) {
                    const ch = charOf.get(name);
                    if (ch === undefined) { ok = false; break; }
                    seq += ch;
                }
                if (!ok) continue;
                // Only set if the target glyph exists and has no charCode yet
                const target = itemByName.get(targetName);
                if (!target || target.charCode != null) continue;
                target.charCode = seq;
            }
        }
    }

    // ── (SVG kerning import intentionally removed) ────────────────
    // SVG <hkern> parsing was dropped by design: it is complex (g1/g2/u1/u2
    // lists + ranges + char→glyph mapping) and SVG font files are an edge
    // case. Kerning pairs are re-authorable inside InkShader itself.

    /**
     * Import a single GLIF file: create group + curves from outline data.
     */
    _importGLIF(glifText, glyphName, c) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(glifText, 'text/xml');
        const glyphEl = doc.documentElement;
        if (!glyphEl || glyphEl.tagName !== 'glyph') return false;

        // Glyph name comes from contents.plist (the authoritative mapping),
        // NOT from the GLIF `name` attribute: the UFO spec says the
        // attribute should be ignored when reading, since manual editing may
        // have caused it to mismatch the contents.plist key (and a mismatch
        // could silently overwrite a differently-cased glyph of the same
        // name). Our own export keeps them in sync.
        const name = glyphName;
        // Overwrite existing group with same name instead of creating duplicate
        if (c.curve_manager.treeItems.has(name)) {
            c.curve_manager.treeStore.deleteTreeItem(name);
        }
        const uniqueName = name;

        // Extract unicode
        let unicode = null;
        const unicodeEls = glyphEl.querySelectorAll('unicode');
        if (unicodeEls.length > 0) {
            const hex = unicodeEls[0].getAttribute('hex');
            if (hex) {
                // fromCodePoint (not fromCharCode): correct for astral-plane
                // characters (U+10000 and above), matching export's codePointAt.
                unicode = String.fromCodePoint(parseInt(hex, 16));
            }
        }

        // Extract advance
        let advance = 1000;
        const advanceEl = glyphEl.querySelector('advance');
        if (advanceEl) {
            const w = advanceEl.getAttribute('width');
            if (w) advance = parseFloat(w);
        }

        // Extract components (references to other glyphs)
        const components = glyphEl.querySelectorAll('component');

        // Create root-level group
        const groupId = uniqueName;
        c.curve_manager.treeStore.treeItems.set(groupId, {
            id: groupId, type: 'group', name: uniqueName,
            charCode: unicode, parentId: null,
            children: [], isRef: false, refId: null, collapsed: false,
            // hidden_by_sequence: the sequence is empty on import, so
            // glyphs are hidden from the moment they are created — a
            // mid-import render (commit_curve → notifyTreeUpdate, async
            // glyph loop) must not flash them in the object tree.
            hidden_by_sequence: true,
            // is_modified: imported glyphs must survive cleanup
            // (cleanupUnusedEmptyGroups / syncTreeWithSequence delete
            // empty, unmodified, non-sequenced root groups).
            is_modified: true,
            advance: advance
        });
        c.curve_manager.rootChildren.push(groupId);

        // Parse contours → curves
        const contours = glyphEl.querySelectorAll('contour');
        for (const contour of contours) {
            const curve = this._parseGLIFContour(contour, c);
            if (curve) {
                c.curve_manager.addPath(curve, groupId);
            }
        }

        // Components are NOT resolved here: the referenced base glyph may
        // appear LATER in contents.plist order (UFO does not guarantee any
        // order). Collect them and let _importUFOFromZip apply them in a
        // second pass once every glyph exists. Matrix is stored in UFO
        // coordinate space; conversion happens at application time.
        const comps = [];
        for (const compEl of components) {
            const baseName = compEl.getAttribute('base');
            if (!baseName) continue;
            comps.push({
                baseName: this._unescapeXml(baseName),
                refName: compEl.getAttribute('data-ref-name') || null,
                xScale: parseFloat(compEl.getAttribute('xScale')) || 1,
                xyScale: parseFloat(compEl.getAttribute('xyScale')) || 0,
                yxScale: parseFloat(compEl.getAttribute('yxScale')) || 0,
                yScale: parseFloat(compEl.getAttribute('yScale')) || 1,
                xOffset: parseFloat(compEl.getAttribute('xOffset')) || 0,
                yOffset: parseFloat(compEl.getAttribute('yOffset')) || 0
            });
        }

        return { ok: true, components: comps, groupId };
    }

    /**
     * Second phase of GLIF import: resolve <component> references into
     * group refs. Runs AFTER all glyphs have been imported so a component
     * whose base glyph appears later in contents.plist still resolves.
     * @param {Array} components - collected component descriptors
     * @param {object} c - canvas
     * @param {string} groupId - owning glyph group id
     */
    _applyGLIFComponents(components, c, groupId) {
        const asc = c.fontSettings?.ascender ?? 800;
        for (const comp of components) {
            // Look up the target group by name
            const targetGroup = c.curve_manager.getGroupByName(comp.baseName);
            if (!targetGroup) continue;
            // Read UFO-space transform attributes and convert to canvas Y-down space.
            // This is the inverse of the export transform in exportToUFO:
            //   ufoA=a, ufoB=-b, ufoC=-c, ufoD=d, ufoE=e+c*0.8h, ufoF=-f+0.8h-d*0.8h
            const matrix = new DOMMatrix([
                comp.xScale,        // a = ufoA
                -comp.xyScale,      // b = -ufoB
                -comp.yxScale,      // c = -ufoC
                comp.yScale,        // d = ufoD
                comp.xOffset + comp.yxScale * asc,      // e = ufoE + ufoC * asc
                asc - comp.yScale * asc - comp.yOffset // f = asc - ufoD*asc - ufoF
            ]);
            c.curve_manager.pasteGroupRef(targetGroup.id, groupId, matrix, comp.refName);
        }
    }

    /**
     * Parse a GLIF <contour> element into an InkShader Curve.
     * Two-pass: first create vertex nodes, then attach control handles.
     */
    _parseGLIFContour(contourEl, c) {
        const ptEls = contourEl.querySelectorAll('point');
        if (ptEls.length < 2) return null;

        // UFO uses Y-up, canvas uses Y-down — flip Y to match canvas space.
        // Baseline model Y = ascender; font Y = ascender - modelY.
        const asc = c.fontSettings?.ascender ?? 800;
        const flipY = (y) => asc - y;

        // Collect raw point data
        const pts = [];
        for (const el of ptEls) {
            // GLIF native smooth attribute (yes/no) — authoritative when present;
            // fall back to geometric classification when absent (e.g. files from
            // tools that omit it, like our pre-Session-9 exports).
            const smoothAttr = el.getAttribute('smooth');
            pts.push({
                x: parseFloat(el.getAttribute('x')),
                y: flipY(parseFloat(el.getAttribute('y'))),
                type: el.getAttribute('type') || null,
                smooth: smoothAttr === 'yes' ? true : smoothAttr === 'no' ? false : null
            });
        }

        // ── On/off-curve classification ──
        // GLIF spec: points with no `type` attribute default to offcurve;
        // on-curve points are explicitly type="move|line|curve|qcurve".
        // (Our older exporter omitted `type` on control points — those
        // files match the spec default and still import correctly.)
        const isOnCurve = (p) => p.type != null && p.type !== 'offcurve';

        // Contours are cyclic; a run of off-curve points may wrap around the
        // array end. Rotate so the sequence starts at an on-curve point —
        // then every off-curve run has an on-curve before it and the next
        // on-curve after it within the array.
        let firstOnIdx = pts.findIndex(p => isOnCurve(p));
        if (firstOnIdx === -1 && pts.length > 0) {
            // All-off-curve contour: per the GLIF spec it "must be treated
            // as a quadratic curve" — the TrueType rule inserts an implied
            // on-curve point at the midpoint between the last and first
            // off-curve points, then processing continues normally.
            const last = pts[pts.length - 1];
            pts.splice(0, 0, { x: (pts[0].x + last.x) / 2, y: (pts[0].y + last.y) / 2, type: 'line' });
            firstOnIdx = 0;
        }
        if (firstOnIdx > 0) {
            pts.push(...pts.splice(0, firstOnIdx));
        }
        // An open contour starts with a move point (GLIF spec: "A point of
        // this type must be the first in a contour"); anything else is a
        // closed contour. The rotation above keeps a leading move first.
        const isOpen = pts[0].type === 'move';

        // ── TrueType implied on-curve points ──
        // A quadratic segment (type="qcurve") may have 2+ consecutive
        // off-curve points; per the TrueType rule an on-curve point is
        // implied at the midpoint of each adjacent pair. Insert synthetic
        // on-curve points so the run splits into single-QCP quadratics
        // (handled by PASS 2 below). Cubic segments (exactly 2 off-curves
        // after a "curve" on-curve) are untouched.
        const expanded = [];
        for (let i = 0; i < pts.length; i++) {
            if (isOnCurve(pts[i])) {
                expanded.push(pts[i]);
                continue;
            }
            // Off-curve run starting at i
            let j = i + 1;
            while (j < pts.length && !isOnCurve(pts[j])) j++;
            const runLen = j - i;
            const prevOn = pts[(i - 1 + pts.length) % pts.length];
            const isQuadRun = prevOn.type === 'qcurve' || runLen >= 3;
            if (runLen >= 2 && isQuadRun) {
                // Interleave implied on-curve midpoints: off, mid, off, mid, ..., off
                for (let k = i; k < j; k++) {
                    expanded.push(pts[k]);
                    if (k < j - 1) {
                        expanded.push({
                            x: (pts[k].x + pts[k + 1].x) / 2,
                            y: (pts[k].y + pts[k + 1].y) / 2,
                            type: "line" // implied on-curve (TrueType rule)
                        });
                    }
                }
            } else {
                for (let k = i; k < j; k++) expanded.push(pts[k]);
            }
            i = j - 1;
        }
        pts.length = 0;
        pts.push(...expanded);

        // Find on-curve point indices
        const onCurveIdxs = [];
        for (let i = 0; i < pts.length; i++) {
            if (isOnCurve(pts[i])) onCurveIdxs.push(i);
        }
        if (onCurveIdxs.length < 1) return null;

        const curve = c.curve_manager.create_temp_curve();
        curve.closed = !isOpen;
        curve.stroke_width = 0;
        curve.smart_stroke = false;

        // PASS 1: Create vertex nodes for all on-curve points
        const vertexData = []; // { marker, node }
        const onCurveToVertex = new Map(); // pts index → vertex entry

        for (let s = 0; s < onCurveIdxs.length; s++) {
            const idx = onCurveIdxs[s];
            const pt = pts[idx];
            const marker = generateMarker("vertex");
            const prevMarker = s > 0 ? vertexData[s - 1].marker : null;

            c.curve_manager.add_node_by_curve(
                marker, "vertex", pt.x, pt.y,
                null, prevMarker, curve, String(marker.id)
            );

            const node = c.curve_manager.curveStore.find_node_by_curve(marker);
            // Authoritative GLIF smooth metadata, when present (see _finalizeImportedControlModes).
            if (pt.smooth != null) node.importedSmooth = pt.smooth;
            const entry = { marker, node };
            vertexData.push(entry);
            onCurveToVertex.set(idx, entry);
        }

        // PASS 2: Set control handles based on off-curve points between consecutive on-curves
        for (let s = 0; s < onCurveIdxs.length; s++) {
            // Open contours have no closing segment (a move start has no
            // implicit wrap-around handle run back to the first point)
            if (isOpen && s === onCurveIdxs.length - 1) continue;
            const curIdx = onCurveIdxs[s];
            const nextIdx = onCurveIdxs[(s + 1) % onCurveIdxs.length];

            // Collect off-curve points between curIdx and nextIdx,
            // wrapping around the array end (contours are cyclic: a contour
            // may end with off-curve points that control the closing segment)
            const offCurves = [];
            for (let step = 1; step < pts.length; step++) {
                const j = (curIdx + step) % pts.length;
                if (j === nextIdx) break;
                offCurves.push(pts[j]);
            }

            const curEntry = vertexData[s];
            const nextEntry = vertexData[(s + 1) % vertexData.length];
            if (!curEntry || !curEntry.node || !nextEntry || !nextEntry.node) continue;

            const curNode = curEntry.node;
            const nextNode = nextEntry.node;

            if (offCurves.length === 2) {
                // GLIF cubic: ordering matches getSkeletonBezierSegments:
                //   p1 = curNode.control1, p2 = nextNode.control2
                // so offCurves[0] → curNode.control1, offCurves[1] → nextNode.control2
                const [bcp1, bcp2] = offCurves;

                if (bcp1.x !== curNode.x || bcp1.y !== curNode.y) {
                    const c1Marker = generateMarker("circle");
                    const c1Node = new CurveNode(c1Marker, null, bcp1.x, bcp1.y, curNode, null, String(c1Marker.id));
                    c1Node.curve = curve;
                    curNode.control1 = c1Node;
                    curve.domMap.set(c1Marker, c1Node);
                    c.curve_manager.domMap.set(c1Marker, c1Node);
                }
                if (bcp2.x !== nextNode.x || bcp2.y !== nextNode.y) {
                    const c2Marker = generateMarker("circle");
                    const c2Node = new CurveNode(c2Marker, null, bcp2.x, bcp2.y, nextNode, null, String(c2Marker.id));
                    c2Node.curve = curve;
                    nextNode.control2 = c2Node;
                    curve.domMap.set(c2Marker, c2Node);
                    c.curve_manager.domMap.set(c2Marker, c2Node);
                }
            } else if (offCurves.length === 1) {
                // Quadratic bezier → convert to cubic (one off-curve = QCP)
                const qcp = offCurves[0];
                const c1x = curNode.x + (2 / 3) * (qcp.x - curNode.x);
                const c1y = curNode.y + (2 / 3) * (qcp.y - curNode.y);
                const c2x = nextNode.x + (2 / 3) * (qcp.x - nextNode.x);
                const c2y = nextNode.y + (2 / 3) * (qcp.y - nextNode.y);

                const c2Marker = generateMarker("circle");
                const c2Node = new CurveNode(c2Marker, null, c1x, c1y, curNode, null, String(c2Marker.id));
                c2Node.curve = curve;
                curNode.control2 = c2Node;
                curve.domMap.set(c2Marker, c2Node);
                c.curve_manager.domMap.set(c2Marker, c2Node);

                const c1Marker = generateMarker("circle");
                const c1Node = new CurveNode(c1Marker, null, c2x, c2y, nextNode, null, String(c1Marker.id));
                c1Node.curve = curve;
                nextNode.control1 = c1Node;
                curve.domMap.set(c1Marker, c1Node);
                c.curve_manager.domMap.set(c1Marker, c1Node);
            }
            // 0 off-curves = straight line (no handles needed)
        }

        // Classify control_mode from geometry AFTER all handles are attached:
        // a node's control1 and control2 are set in different loop iterations,
        // and CurveNode defaults to control_mode=2 (symmetric), which would
        // corrupt asymmetric handles on later edits (set_both_control mirroring).
        this._finalizeImportedControlModes(curve);

        return curve;
    }

    /**
     * Infer control_mode (0=corner, 1=smooth, 2=symmetric) from actual handle
     * geometry. Imported outlines (UFO/SVG) carry no handle-type information;
     * CurveNode defaults to control_mode=2, which is wrong for arbitrary
     * geometry. Convention matches curve_store handle-delete behavior:
     * no handles → 0, single handle → 1, both handles → classify collinearity.
     */
    _classifyControlModeFromGeometry(node) {
        const c1 = node.control1, c2 = node.control2;
        if (!c1 && !c2) return 0;
        if (!c1 || !c2) return 1;
        const v1x = c1.x - node.x, v1y = c1.y - node.y;
        const v2x = c2.x - node.x, v2y = c2.y - node.y;
        const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
        if (l1 < 1e-9 || l2 < 1e-9) return 0;
        const cross = v1x * v2y - v1y * v2x;
        const dot = v1x * v2x + v1y * v2y;
        const sinAng = Math.abs(cross) / (l1 * l2);
        // Collinearity tolerance 5e-3 (~0.29°): true smooth points deviate from
        // exact collinearity by up to ~0.3° due to drawing/export rounding
        // (user case: handles at -43.7°/136.4° = 0.1° off, sinAng 1.75e-3).
        // Kept tight enough that real corners (handles diverging >0.29°) stay
        // corners; near-collinear corners (<0.29°) classify smooth.
        if (sinAng > 5e-3) return 0; // not collinear → corner
        if (dot >= 0) return 0;      // same direction → corner
        if (Math.abs(l1 - l2) / Math.max(l1, l2) < 1e-3) return 2; // opposite, equal → symmetric
        return 1;                    // opposite, unequal → smooth
    }

    /**
     * Walk an imported curve and classify every node's control_mode.
     * Priority: authoritative GLIF `smooth` metadata (set during point parsing)
     * → geometric classification fallback (SVG path data, and GLIF files from
     * tools that omit the attribute). Must run AFTER both handles of each
     * node are attached.
     */
    _finalizeImportedControlModes(curve) {
        let node = curve.startNode;
        const seen = new Set();
        while (node && !seen.has(node)) {
            seen.add(node);
            if (node.importedSmooth != null) {
                // GLIF smooth="yes" → never a corner; symmetric (2) only when the
                // geometry is clearly an equal-length mirror. smooth="no" → corner.
                if (node.importedSmooth === true) {
                    // No handles → corner regardless (matches curve_store semantics).
                    if (!node.control1 && !node.control2) node.control_mode = 0;
                    else {
                        const geo = this._classifyControlModeFromGeometry(node);
                        node.control_mode = geo === 2 ? 2 : 1;
                    }
                } else {
                    node.control_mode = 0;
                }
            } else {
                node.control_mode = this._classifyControlModeFromGeometry(node);
            }
            if (node === curve.endNode) break;
            node = node.nextOnCurve;
        }
    }

    /**
     * True when `child` is a group reference whose target is a root-level
     * glyph — a font "component". Such refs are exported structurally as
     * UFO <component> and re-imported as group refs, preserving the
     * reference instead of flattening it into the glyph's own outline.
     * Refs whose target is a non-root subgroup still flatten inline
     * (UFO has no subgroup-component concept). NOTE: the SVG export
     * expands ALL refs inline into the font d — FontForge cannot read
     * custom data-refs and needs pure path data (see _buildGlyphSVGPaths).
     */
    _isRefToRootGlyph(child) {
        if (!child || child.type !== 'group' || !child.isRef || !child.refId) return false;
        const cm = this.canvas?.curve_manager;
        if (!cm) return false;
        const refTarget = cm.treeItems?.get(child.refId);
        return !!(refTarget && refTarget.type === 'group'
            && (cm.rootChildren || []).includes(refTarget.id));
    }

    /**
     * Build SVG path d-attribute for a glyph (recursive). ALL refs —
     * including refs to root-level glyphs — expand inline with their
     * transform matrix applied: the SVG font layer must be plain path
     * data (FontForge/Inkscape read only `d`, not custom data-refs).
     */
    _buildGlyphSVGPaths(recorder, groupId, matrix) {
        const c = this.canvas;
        const grpItem = c.curve_manager.treeItems.get(groupId);
        if (!grpItem || !grpItem.children) return;

        for (const childId of grpItem.children) {
            const child = c.curve_manager.treeItems.get(childId);
            if (!child) continue;

            if (child.type === 'curve') {
                const curve = c.curve_manager.curveById.get(child.curveId);
                // Same rule as UFO export: closed fill rings AND open curves
                // (SVG supports open subpaths — M without Z).
                if (curve && curve.startNode && curve.visible !== false
                    && (curveGeneratesFillArea(curve) || !curve.closed)) {
                    appendCurveOutlinePath(recorder, curve, {
                        scale: 1, offsetX: 0, offsetY: 0, seqOffsetX: 0,
                        matrix: matrix || null
                    }, { pass: "fill" });
                }
            } else if (child.type === 'group') {
                if (child.isRef) {
                    // Expand ALL refs inline (root-glyph refs included): the
                    // SVG font layer carries pure path data, no data-refs.
                    const childMatrix = matrix
                        ? new DOMMatrix(matrix).multiply(child.transform || new DOMMatrix())
                        : new DOMMatrix(child.transform || new DOMMatrix());
                    this._buildGlyphSVGPaths(recorder, child.refId, childMatrix);
                } else {
                    this._buildGlyphSVGPaths(recorder, childId, matrix);
                }
            }
        }
    }

    exportToSVG() {
        const c = this.canvas;
        const active = document.activeElement;
        if (active && document.querySelector('font-popup')?.contains(active)) {
            active.blur();
        }
        const esc = (s) => this._escXml(s);

        let fontSettings = {
            family: "InkShader Font",
            style: "Regular",
            upm: 1000,
            ascender: 800,
            descender: -200,
            ...(c.fontSettings || {})
        };

        const upm = fontSettings.upm;
        const asc = fontSettings.ascender ?? 800;

        // Y-flip for font layer: baseline model Y = ascender
        // canvas Y=0 (top) → font Y = ascender
        // canvas Y=ascender (baseline) → font Y = 0
        // canvas Y=ascender-descender (bottom) → font Y = -descender
        // Font layer coordinates keep FULL precision (toFixed(5), NOT
        // Math.round) — the SVG import path classifies smoothness purely
        // from handle geometry (no smooth attribute), and the expanded
        // stroke outlines have short handles where a 0.5-unit rounding
        // distorts angles by degrees, misclassifying smooth nodes as
        // corners (measured: 118/257 vs 9/581 baseline). Trade-off: this
        // means FontForge produces larger OTFs from the SVG path — it
        // preserves fractional coords as 16.16 fixed-point in CFF (~3x
        // size) — but the UFO path (integer GLIF + smooth attr) is the
        // compact, lossless interchange. FontForge users can run
        // Element > Round To Int (or glyph.round() in ffpython) before
        // generating to get UFO-sized OTFs.
        const fyFont = (y) => parseFloat((asc - y).toFixed(5));
        const fyVis = (y) => Math.round(y);

        // SvgPathRecorder: accumulates commands for a single SVG path d="..."
        class SvgPathRecorder {
            constructor(fy) {
                this.parts = [];
                this._fy = fy || (v => parseFloat(v.toFixed(5)));
            }
            moveTo(x, y) {
                this.parts.push(`M${parseFloat(x.toFixed(5))},${this._fy(y)}`);
            }
            lineTo(x, y) {
                this.parts.push(`L${parseFloat(x.toFixed(5))},${this._fy(y)}`);
            }
            bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
                this.parts.push(`C${parseFloat(c1x.toFixed(5))},${this._fy(c1y)} ${parseFloat(c2x.toFixed(5))},${this._fy(c2y)} ${parseFloat(x.toFixed(5))},${this._fy(y)}`);
            }
            closePath() {
                this.parts.push('Z');
            }
            getD() {
                return this.parts.join('');
            }
        }

        // Build unicode attribute value
        const getUnicodeAttr = (item) => {
            if (item.charCode == null) return 'unicode=""';
            return `unicode="${esc(String(item.charCode))}"`;
        };

        // Build visual layer label
        const getLayerLabel = (item) => {
            if (item.charCode == null) return esc(item.name);
            const hexStrs = Array.from(String(item.charCode))
                .map(ch => 'U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
                .join(' ');
            return `${hexStrs} ${esc(item.name)}`;
        };

        let fontGlyphs = '';
        let visualLayers = '';
        let glyphIndex = 1;
        const usedGlyphIds = new Set();

        // ── Build SVG font kerning (<hkern>) from KerningManager ──
        const buildKernElements = () => {
            const kernEls = [];
            const km = c.curve_manager?.kerningManager;
            if (!km) return '';

            // Helper: escape glyph name for use in g1/g2 attributes
            const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            // 1. Exact pairs: <hkern g1="L" g2="R" k="val" />
            // SVG 1.1 convention: POSITIVE k reduces the advance (glyphs
            // closer). Our kerning values use the UFO/FontForge convention
            // (negative = closer), and FontForge's SVG importer negates k
            // on read (fontforge/svg.c SVGParseKern: off = -strtod(k)) —
            // so the exported k is the NEGATED project value.
            for (const { left, right, value } of km.getAllPairs()) {
                if (value === 0) continue;
                kernEls.push(`      <hkern g1="${escAttr(left)}" g2="${escAttr(right)}" k="${-Math.round(value)}" />`);
            }

            // 2. Class-to-class pairs: expand to all member combinations
            for (const { leftClass, rightClass, value } of km.getAllClassValues()) {
                if (value === 0) continue;
                const leftMembers = km.getClassMembers('left', leftClass);
                const rightMembers = km.getClassMembers('right', rightClass);
                for (const l of leftMembers) {
                    for (const r of rightMembers) {
                        kernEls.push(`      <hkern g1="${escAttr(l)}" g2="${escAttr(r)}" k="${-Math.round(value)}" />`);
                    }
                }
            }

            // 3. Mixed pairs (class↔glyph): expand with the class side
            for (const { type, className, glyphName, value } of km.getAllMixedPairs()) {
                if (value === 0) continue;
                if (type === 'leftClass') {
                    const members = km.getClassMembers('left', className);
                    for (const l of members) {
                        kernEls.push(`      <hkern g1="${escAttr(l)}" g2="${escAttr(glyphName)}" k="${-Math.round(value)}" />`);
                    }
                } else { // rightClass
                    const members = km.getClassMembers('right', className);
                    for (const r of members) {
                        kernEls.push(`      <hkern g1="${escAttr(glyphName)}" g2="${escAttr(r)}" k="${-Math.round(value)}" />`);
                    }
                }
            }

            return kernEls.join('\n');
        };

        // SVG 1.1 glyph selection searches <glyph> elements in document order
        // and uses the first match: ligature glyphs MUST precede their
        // single-char components, otherwise they are never selected.
        const svgGlyphIds = this._svgGlyphExportOrder(
            c.curve_manager.treeItems, c.curve_manager.rootChildren || []);
        for (const rootChildId of svgGlyphIds) {
            const item = c.curve_manager.treeItems.get(rootChildId);

            const glyphName = item.name;
            const advance = item.advance !== undefined ? item.advance : upm;

            // XML-id-safe glyph name for the visual layer <g> (Inkscape
            // shows group ids as layer names). Deduped against earlier
            // glyphs; invalid id chars are replaced with '_'.
            let glyphId = String(glyphName).replace(/[^a-zA-Z0-9_.\-]/g, '_');
            if (!/^[a-zA-Z_]/.test(glyphId)) glyphId = 'glyph-' + glyphId;
            while (usedGlyphIds.has(glyphId)) glyphId += '_';
            usedGlyphIds.add(glyphId);

            // Build font-layer path (Y-up for FontForge)
            const fontRecorder = new SvgPathRecorder(fyFont);
            this._buildGlyphSVGPaths(fontRecorder, item.id, null);
            const fontD = fontRecorder.getD();

// Build visual-layer paths (canvas Y-down). One <path> per curve so
            // each keeps its original stroke-width. Smart strokes export as the
            // raw skeleton (pass:"skeleton" — pre-expand data) instead of their
            // boolean-expanded outline: Inkscape shows an editable stroked path,
            // exactly the reversible vector data the visual layer promises.
            const visPaths = [];
            const buildVisualPaths = (groupId, visMatrix) => {
                const grpItem = c.curve_manager.treeItems.get(groupId);
                if (!grpItem || !grpItem.children) return;
                for (const childId of grpItem.children) {
                    const child = c.curve_manager.treeItems.get(childId);
                    if (!child) continue;
                    if (child.type === 'curve') {
                        const curve = c.curve_manager.curveById.get(child.curveId);
                        if (curve && curve.startNode && curve.visible !== false
                            && (curveGeneratesFillArea(curve) || !curve.closed)) {
                            const rec = new SvgPathRecorder(fyVis);
                            appendCurveOutlinePath(rec, curve, {
                                scale: 1, offsetX: 0, offsetY: 0, seqOffsetX: 0,
                                matrix: visMatrix || null
                            }, { pass: "skeleton" });
                            const d = rec.getD();
                            if (d) visPaths.push({ d, strokeWidth: curve.stroke_width || 0 });
                        }
                    } else if (child.type === 'group') {
                        if (child.isRef) {
                            // Always expand refs inline for SVG (no <use> / <component>)
                            const childMatrix = visMatrix
                                ? new DOMMatrix(visMatrix).multiply(child.transform || new DOMMatrix())
                                : new DOMMatrix(child.transform || new DOMMatrix());
                            buildVisualPaths(child.refId, childMatrix);
                        } else {
                            buildVisualPaths(childId, visMatrix);
                        }
                    }
                }
            };
            buildVisualPaths(item.id, null);
            const visPathEls = visPaths.map((p, i) =>
                `      <path\n         style="fill:none;stroke:#000000;stroke-width:${p.strokeWidth > 0 ? p.strokeWidth : 1}"\n         id="path${glyphIndex}_${i + 1}"\n         d="${esc(p.d)}" />`
            ).join('\n');

            // ── Font layer glyph ──
            // No data-refs: every reference is expanded inline into the d
            // by _buildGlyphSVGPaths, so FontForge/Inkscape see pure path
            // data. The UFO export (standard <component>) is the format
            // that preserves structural refs.
            const advAttr = advance !== upm ? `\n         horiz-adv-x="${advance}"` : '';
            fontGlyphs += `      <glyph\n         glyph-name="${esc(glyphName)}"\n         ${getUnicodeAttr(item)}\n         id="glyph${glyphIndex}"${advAttr}\n         d="${esc(fontD)}" />\n`;

            // ── Visual layer group + per-curve paths (standard SVG, no Inkscape attrs) ──
            visualLayers += `    <g\n       id="${glyphId}"\n       data-name="${getLayerLabel(item)}">\n${visPathEls}\n    </g>\n`;

            glyphIndex++;
        }

        const kernElements = buildKernElements();
        const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // ── <font> id: use family name (sanitized) ──
        const fontNameId = fontSettings.family.replace(/[^a-zA-Z0-9_\-]/g, '_');

        // ── Map style name to SVG font-style ──
        const svgFontStyle = ({
            'italic': 'italic',
            'oblique': 'oblique',
        })[String(fontSettings.style).toLowerCase()] || 'normal';

        // ── Map weight_class to SVG font-weight (direct 100-900 scale) ──
        const svgFontWeight = fontSettings.weight_class != null
            ? Math.round(fontSettings.weight_class)
            : 400;

        // ── Map width_class to SVG font-stretch ──
        const stretchMap = {
            1: 'ultra-condensed', 2: 'extra-condensed', 3: 'condensed',
            4: 'semi-condensed', 5: 'normal', 6: 'semi-expanded',
            7: 'expanded', 8: 'extra-expanded', 9: 'ultra-expanded'
        };
        const svgFontStretch = stretchMap[fontSettings.width_class] || 'normal';

        // ── Build <metadata> with font legal / description fields ──
        const metaLines = [];
        const metaKV = (key, val) => {
            if (val != null && val !== '') metaLines.push(`       ${key}="${escAttr(String(val))}"`);
        };
        metaKV('version', fontSettings.version);
        metaKV('copyright', fontSettings.copyright);
        metaKV('designer', fontSettings.designer);
        metaKV('designer_url', fontSettings.designer_url);
        metaKV('manufacturer', fontSettings.manufacturer);
        metaKV('manufacturer_url', fontSettings.manufacturer_url);
        metaKV('license', fontSettings.license);
        metaKV('license_url', fontSettings.license_url);
        metaKV('trademark', fontSettings.trademark);
        metaKV('description', fontSettings.description);
        metaKV('sample_text', fontSettings.sample_text);
        metaKV('preferred_family', fontSettings.preferred_family);
        metaKV('preferred_subfamily', fontSettings.preferred_subfamily);
        metaKV('style_map_family', fontSettings.style_map_family);
        metaKV('italic_angle', fontSettings.italic_angle);
        // NOTE: element local name must NOT be "font" — FontForge's SVG
        // parser collects every element whose local name is "font"
        // (namespace-agnostic, _FindSVGFontNodes in fontforge/svg.c) as a
        // candidate font; an id-less one then appears as "nameless-font"
        // in the import picker ("there are multiple fonts in this file").
        const metadataXml = metaLines.length > 0
            ? `  <metadata>\n    <inkshader:font-meta\n       xmlns:inkshader="https://inkshader.app/ns/1.0"\n${metaLines.join('\n')} />\n    </metadata>\n`
            : '';
        // ── Build version comment for human readers ──
        const metaComment = fontSettings.version
            ? `\n   Version ${escAttr(fontSettings.version)}`
            : '';

        const svgStr = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   width="${upm}"
   height="${upm}"
   viewBox="0 0 ${upm} ${upm}"
   version="1.1"
   xmlns="http://www.w3.org/2000/svg"
   data-project-name="${escAttr(fontSettings.project_name || '')}">
  <defs>
    <font
       horiz-adv-x="${upm}"
       id="${escAttr(fontNameId)}"
       horiz-origin-x="0"
       horiz-origin-y="0">
      <font-face
         font-family="${esc(fontSettings.family)}"
         font-style="${svgFontStyle}"
         font-weight="${svgFontWeight}"
         font-stretch="${svgFontStretch}"
         units-per-em="${upm}"
         ascent="${fontSettings.ascender}"
         descent="${fontSettings.descender}"
         cap-height="${fontSettings.cap_height ?? Math.round(upm * 0.7)}"
         x-height="${fontSettings.x_height ?? Math.round(upm * 0.5)}" />${metaComment}
      <missing-glyph
         d="M0,0h${upm}v${upm}h${-upm}z"
         horiz-adv-x="${upm}"
         id="missing-glyph1" />
${fontGlyphs}${kernElements}    </font>
  </defs>
${metadataXml}  <g
     id="glyph-layers"
     data-name="${esc(fontSettings.family)}">
${visualLayers}  </g>
</svg>`;

        const blob = new Blob([svgStr], { type: "image/svg+xml" });
        const url = c.env.createObjectURL(blob);
        const a = c.env.createDOMElement("a");
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
        a.download = `InkShader_export_${dateStr}.svg`;
        const bodyDOM = c.env.queryDOM("body");
        if (bodyDOM) {
            bodyDOM.appendChild(a);
            a.click();
            bodyDOM.removeChild(a);
        }
        c.env.revokeObjectURL(url);
    }
}
