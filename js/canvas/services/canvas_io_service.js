import { CanvasDispatcher } from "../../app/canvas_dispatcher.js";
import { StorageUtils } from "../../services/storage.js";
import { appendCurveOutlinePath, curveGeneratesFillArea } from "../rendering/curve_renderer.js";
import { generateMarker } from "../../core/bezier/utils.js";
import { CurveNode } from "../../core/bezier/node.js";
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
            font_settings: c.fontSettings || {}
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
        const ufoFolder = zip.folder("font.ufo");
        const glyphsFolder = ufoFolder.folder("glyphs");

        // ── Build fontinfo.plist (all metadata fields from fontSettings) ──
        const fi = [];
        const fiKV = (key, type, val) => {
            if (val === undefined || val === null) return;
            const v = type === 'string' ? esc(val) : Math.round(Number(val));
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

        // OpenType OS/2 table fields
        fiKV('openTypeOS2WeightClass', 'integer', fontSettings.weight_class);
        fiKV('openTypeOS2WidthClass', 'integer', fontSettings.width_class);

        // Guidelines (from canvas, Y-flipped to UFO coordinate space)
        const guidelines = (c.guidelines || []).filter(g => !g._temp);
        if (guidelines.length > 0) {
            fi.push('    <key>guidelines</key>\n    <array>');
            for (const g of guidelines) {
                fi.push('      <dict>');
                fi.push(`        <key>x</key><integer>${Math.round(g.x)}</integer>`);
                fi.push(`        <key>y</key><integer>${Math.round(0.8 * c.canvas_size_height - g.y)}</integer>`);
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
        ufoFolder.file("features.fea", "# OpenType Feature File\n");
        let contentsDict = "";

        // GlifRecorder: produces GLIF outline XML (contours + components)
        class GlifRecorder {
            constructor(canvasHeight) {
                this.contours = [];
                this.components = [];
                this.currentContour = null;
                this.h = canvasHeight;
            }
            _fy(y) { return 0.8 * this.h - y; }
            moveTo(x, y) {
                this._flushContour();
                this.currentContour = { closed: false, points: [] };
                this.currentContour.points.push({ x, y, type: "move" });
            }
            lineTo(x, y) {
                if (this.currentContour) this.currentContour.points.push({ x, y, type: "line" });
            }
            bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
                if (this.currentContour) {
                    this.currentContour.points.push({ x: c1x, y: c1y, type: "" });
                    this.currentContour.points.push({ x: c2x, y: c2y, type: "" });
                    this.currentContour.points.push({ x, y, type: "curve" });
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
            addComponent(baseName, a, b, c, d, e, f) {
                this.components.push({ baseName, a, b, c, d, e, f });
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
                    if (comp.e !== 0) attrs += ` xOffset="${Math.round(comp.e)}"`;
                    if (comp.f !== 0) attrs += ` yOffset="${Math.round(comp.f)}"`;
                    xml += `    <component ${attrs}/>\n`;
                }
                // Contours
                for (const contour of this.contours) {
                    if (contour.points.length === 0) continue;
                    xml += "    <contour>\n";
                    for (const p of contour.points) {
                        if (p.type === "") xml += `      <point x="${Math.round(p.x)}" y="${Math.round(this._fy(p.y))}"/>\n`;
                        else xml += `      <point x="${Math.round(p.x)}" y="${Math.round(this._fy(p.y))}" type="${p.type}"/>\n`;
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
                    const curve = c.curve_manager.curveById.get(child.curveId);
                    if (curve && curve.startNode && curve.visible !== false && curveGeneratesFillArea(curve)) {
                        appendCurveOutlinePath(recorder, curve, {
                            scale: 1, offsetX: 0, offsetY: 0, seqOffsetX: 0,
                            matrix: matrix || null
                        }, { pass: "fill" });
                    }
                } else if (child.type === 'group') {
                    if (child.isRef) {
                        const refTarget = c.curve_manager.treeItems.get(child.refId);
                        if (refTarget && refTarget.charCode != null) {
                            // Export as component — only when the target is itself a glyph
                            const m = child.transform || new DOMMatrix();
                            const h = c.canvas_size_height;
                            // Convert canvas-space transform (Y-down) to UFO Y-up space
                            const ufoA = m.a;
                            const ufoB = -m.b;
                            const ufoC = -m.c;
                            const ufoD = m.d;
                            const ufoE = m.e + m.c * 0.8 * h;
                            const ufoF = -m.f + 0.8 * h - m.d * 0.8 * h;
                            recorder.addComponent(refTarget.name, ufoA, ufoB, ufoC, ufoD, ufoE, ufoF);
                        } else if (refTarget) {
                            // Ref to non-glyph: resolve manually with transform
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
        for (const rootChildId of (c.curve_manager.rootChildren || [])) {
            const item = c.curve_manager.treeItems.get(rootChildId);
            if (!item || item.isRef) continue;
            const glyphName = item.name;
            const fileName = `${glyphName}.glif`;
            const advance = item.advance !== undefined ? item.advance : 1000;
            contentsDict += `    <key>${glyphName}</key>\n    <string>${fileName}</string>\n`;

            // Reuse cached GLIF when glyph unchanged
            const cached = glifCache.get(item.id);
            if (cached && cached[0] === advance) {
                glyphsFolder.file(fileName, cached[1]);
                continue;
            }

            let unicodeTag = '';
            if (item.charCode != null) {
                const charStr = String(item.charCode);
                unicodeTag = Array.from(charStr).map(ch =>
                    `<unicode hex="${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}"/>`
                ).join('\n      ');
            }
            const recorder = new GlifRecorder(c.canvas_size_height);
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

    // ── SVG Path Parser ──────────────────────────────────────────

    /**
     * Tokenize an SVG path `d` attribute into structured command objects.
     * Handles implicit repeated commands, relative/absolute, all standard commands.
     * @param {string} dStr - SVG path d attribute
     * @returns {Array<{cmd:string, params:number[]}>}
     */
    _tokenizeSVGPath(dStr) {
        const cmds = [];
        let i = 0;
        const s = dStr.trim();
        const isCmd = (c) => /[MLQCZmlqcz]/.test(c);

        const skip = () => { while (i < s.length && /[\s,]/.test(s[i])) i++; };

        const parseNum = () => {
            skip();
            if (i >= s.length) return NaN;
            let start = i;
            if (s[i] === '+' || s[i] === '-') i++;
            if (i < s.length && s[i] === '.') {
                i++;
                while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
            } else if (i < s.length && s[i] >= '0' && s[i] <= '9') {
                while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
                if (i < s.length && s[i] === '.') {
                    i++;
                    while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
                }
            } else {
                return NaN;
            }
            if (i < s.length && (s[i] === 'e' || s[i] === 'E')) {
                i++;
                if (i < s.length && (s[i] === '+' || s[i] === '-')) i++;
                while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
            }
            return parseFloat(s.slice(start, i));
        };

        const canReadNum = () => { skip(); return i < s.length && /[\d\-+.]/.test(s[i]); };

        let curCmd = '';
        while (i < s.length) {
            skip();
            if (i >= s.length) break;
            const ch = s[i];
            if (isCmd(ch)) {
                curCmd = ch;
                i++;
            }
            // Implicit repeat of curCmd when ch is a number
            if (!curCmd) continue;
            const upper = curCmd.toUpperCase();
            if (upper === 'Z') {
                cmds.push({ cmd: curCmd, params: [] });
                curCmd = '';
                continue;
            }
            const counts = { M: 2, L: 2, C: 6, Q: 4, A: 7 };
            const count = counts[upper];
            if (!count) continue;

            while (canReadNum()) {
                const nums = [];
                for (let n = 0; n < count; n++) {
                    const v = parseNum();
                    if (isNaN(v)) break;
                    nums.push(v);
                }
                if (nums.length < count) break;
                cmds.push({ cmd: curCmd, params: nums });
                // After first M pair, remaining pairs become implicit L
                if (upper === 'M') curCmd = curCmd === 'M' ? 'L' : 'l';
            }
        }
        return cmds;
    }

    /**
     * Convert relative SVG path commands to absolute coordinates.
     * @param {Array<{cmd:string, params:number[]}>} cmds
     * @returns {Array<{cmd:string, params:number[]}>}
     */
    _svgCmdsToAbs(cmds) {
        let cx = 0, cy = 0; // current point
        let sx = 0, sy = 0; // subpath start
        const abs = [];
        for (const { cmd, params } of cmds) {
            const p = params.slice(); // copy
            const up = cmd.toUpperCase();
            const isRel = cmd === cmd.toLowerCase() && up !== 'Z';

            if (up === 'M') {
                if (isRel) { p[0] += cx; p[1] += cy; }
                cx = p[0]; cy = p[1];
                sx = cx; sy = cy;
                abs.push({ cmd: 'M', params: [cx, cy] });
            } else if (up === 'L') {
                if (isRel) { p[0] += cx; p[1] += cy; }
                cx = p[0]; cy = p[1];
                abs.push({ cmd: 'L', params: [cx, cy] });
            } else if (up === 'C') {
                if (isRel) { p[0] += cx; p[1] += cy; p[2] += cx; p[3] += cy; p[4] += cx; p[5] += cy; }
                cx = p[4]; cy = p[5];
                abs.push({ cmd: 'C', params: p });
            } else if (up === 'Q') {
                if (isRel) { p[0] += cx; p[1] += cy; p[2] += cx; p[3] += cy; }
                // Convert quadratic to cubic: C = (Q0 + 2/3(Q1-Q0)), (Q2 + 2/3(Q1-Q2))
                const q0x = cx, q0y = cy;
                const q1x = p[0], q1y = p[1];
                const q2x = p[2], q2y = p[3];
                const c1x = q0x + (2 / 3) * (q1x - q0x);
                const c1y = q0y + (2 / 3) * (q1y - q0y);
                const c2x = q2x + (2 / 3) * (q1x - q2x);
                const c2y = q2y + (2 / 3) * (q1y - q2y);
                cx = q2x; cy = q2y;
                abs.push({ cmd: 'C', params: [c1x, c1y, c2x, c2y, cx, cy] });
            } else if (up === 'A') {
                if (isRel) { p[5] += cx; p[6] += cy; }
                const arcCurves = this._svgArcToCubics(cx, cy, p[0], p[1], p[2], p[3], p[4], p[5], p[6]);
                for (const seg of arcCurves) {
                    cx = seg[4]; cy = seg[5];
                    abs.push({ cmd: 'C', params: seg });
                }
            } else if (up === 'Z') {
                abs.push({ cmd: 'Z', params: [] });
                cx = sx; cy = sy;
            }
        }
        return abs;
    }

    /**
     * Approximate an SVG arc segment with cubic bezier curves.
     * Follows SVG spec appendix: F.6 Elliptical arc implementation notes.
     */
    _svgArcToCubics(x1, y1, rx, ry, xAxisRot, largeArc, sweep, x2, y2) {
        // Basic fallback: line approximation
        // Step 1: Compute center point parameters from endpoint params
        const M = Math.PI / 180;
        const cosA = Math.cos(xAxisRot * M);
        const sinA = Math.sin(xAxisRot * M);

        // Ensure radii are non-zero
        if (rx === 0 || ry === 0) {
            return [[0, 0, 0, 0, x2, y2]];
        }

        // Step 2: Compute (x1', y1') — transformed start point
        const dx = (x1 - x2) / 2;
        const dy = (y1 - y2) / 2;
        let x1p = cosA * dx + sinA * dy;
        let y1p = -sinA * dx + cosA * dy;

        // Correct radii if too small
        let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if (lam > 1) {
            const sqrtLam = Math.sqrt(lam);
            rx *= sqrtLam;
            ry *= sqrtLam;
        }

        // Step 3: Compute (cx', cy')
        const rxSq = rx * rx;
        const rySq = ry * ry;
        const x1pSq = x1p * x1p;
        const y1pSq = y1p * y1p;
        let sign = largeArc === sweep ? -1 : 1;
        let sq = Math.max(0, (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq));
        let cf = sign * Math.sqrt(sq);
        let cxp = cf * (rx * y1p / ry);
        let cyp = cf * (-ry * x1p / rx);

        // Step 4: Compute (cx, cy) from (cx', cy')
        let cx = cosA * cxp - sinA * cyp + (x1 + x2) / 2;
        let cy = sinA * cxp + cosA * cyp + (y1 + y2) / 2;

        // Helper: angle between vectors
        const angle = (ux, uy, vx, vy) => {
            const dot = ux * vx + uy * vy;
            const cross = ux * vy - uy * vx;
            const a = Math.acos(Math.max(-1, Math.min(1, dot / (Math.hypot(ux, uy) * Math.hypot(vx, vy)))));
            return cross < 0 ? -a : a;
        };

        // Step 5: Compute start angle and angular extent
        const vx = (x1p - cxp) / rx;
        const vy = (y1p - cyp) / ry;
        let theta1 = angle(1, 0, vx, vy);

        const vx2 = (-x1p - cxp) / rx;
        const vy2 = (-y1p - cyp) / ry;
        let dTheta = angle(vx, vy, vx2, vy2);

        if (sweep === 0 && dTheta > 0) dTheta -= 2 * Math.PI;
        if (sweep === 1 && dTheta < 0) dTheta += 2 * Math.PI;

        // Split arc into segments (max PI/2 per cubic)
        const segs = Math.ceil(Math.abs(dTheta) / (Math.PI / 2));
        const dThetaSeg = dTheta / segs;
        const result = [];

        for (let s = 0; s < segs; s++) {
            const t1 = theta1 + s * dThetaSeg;
            const t2 = t1 + dThetaSeg;
            const alpha = Math.sin(dThetaSeg) * (Math.sqrt(4 + 3 * Math.pow(Math.tan(dThetaSeg / 2), 2)) - 1) / 3;

            const p0x = cosA * rx * Math.cos(t1) - sinA * ry * Math.sin(t1) + cx;
            const p0y = sinA * rx * Math.cos(t1) + cosA * ry * Math.sin(t1) + cy;
            const p3x = cosA * rx * Math.cos(t2) - sinA * ry * Math.sin(t2) + cx;
            const p3y = sinA * rx * Math.cos(t2) + cosA * ry * Math.sin(t2) + cy;

            const dx1 = -rx * Math.sin(t1);
            const dy1 = ry * Math.cos(t1);
            const p1x = p0x + alpha * (cosA * dx1 - sinA * dy1);
            const p1y = p0y + alpha * (sinA * dx1 + cosA * dy1);

            const dx2 = -rx * Math.sin(t2);
            const dy2 = ry * Math.cos(t2);
            const p2x = p3x - alpha * (cosA * dx2 - sinA * dy2);
            const p2y = p3y - alpha * (sinA * dx2 + cosA * dy2);

            result.push([p1x, p1y, p2x, p2y, p3x, p3y]);
        }

        return result;
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
        const flipY = canvasH != null ? (y) => Math.round(0.8 * canvasH - y) : null;
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
            curve.show_skeleton = true;

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
                            prevNode.control_mode = prevNode.control_mode || 1;
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
                        node.control_mode = node.control_mode || 1;
                    }
                    lastMarker = mainMarker;
                }
            }

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
        if (!dStr || !dStr.trim()) return [];
        const tokens = this._tokenizeSVGPath(dStr);
        const abs = this._svgCmdsToAbs(tokens);
        return this._svgAbsCmdsToCurves(abs, c, targetGroupId, canvasH);
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

        // Extract font-face metadata
        const faceEl = fontEl.querySelector('font-face');
        const upm = parseInt(faceEl?.getAttribute('units-per-em'), 10) || 1000;
        const family = faceEl?.getAttribute('font-family') || 'Imported Font';
        const ascender = parseInt(faceEl?.getAttribute('ascent'), 10) || 800;
        const descender = parseInt(faceEl?.getAttribute('descent'), 10) || -200;
        const capHeight = parseInt(faceEl?.getAttribute('cap-height'), 10) || 0;
        const xHeight = parseInt(faceEl?.getAttribute('x-height'), 10) || 0;

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
            basic_spacing: 1000,
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
        c.currentStateObj = c.history.getHistoryState();

        // Clear stale selection state (same pattern as loadFromFile in ProjectManager)
        c.curve_manager.clearAllSelection();
        c.curve_manager.activeGroupId = null;

        // Import SVG glyphs
        let glyphCount = 0;
        for (const glyphEl of glyphs) {
            const glyphName = glyphEl.getAttribute('glyph-name') || `glyph_${glyphCount}`;
            const unicode = glyphEl.getAttribute('unicode') || null;
            const advance = parseFloat(glyphEl.getAttribute('horiz-adv-x')) || upm;
            const d = glyphEl.getAttribute('d');
            if (!d) continue;

            // Create root-level group
            const groupId = glyphName;
            c.curve_manager.treeStore.treeItems.set(groupId, {
                id: groupId, type: 'group', name: glyphName,
                charCode: unicode || null, parentId: null,
                children: [], isRef: false, refId: null, collapsed: false,
                advance: advance
            });
            c.curve_manager.rootChildren.push(groupId);

            // Parse path data into curves within this group (Y-flip to match UFO-style Y-up coords)
            this._parseSVGPathToCurves(d, c, groupId, c.canvas_size_height);
            glyphCount++;
        }

        if (glyphCount > 0) {
            // ── Rebuild sequence state after importing glyphs ──
            // (same reasoning as UFO import: prevents "A_1" duplicates)
            const seqService = c.curve_manager.seqService;
            const seqChars = [];
            for (const [id, item] of c.curve_manager.treeItems) {
                if (item.type === 'group' && item.parentId === null) {
                    item.hidden_by_sequence = false;
                    if (item.charCode != null) seqChars.push(item.charCode);
                }
            }
            seqService.sequenceText = seqChars.join('');
            seqService._prevInTextIds = null;
            seqService.rebuildDefaultGlyphs();
            seqService.updateSequenceParsing();
            // Activate all sequence positions (all imported glyphs should be active)
            seqService.setActiveIndices(new Set(seqService.sequenceTokens.map((_, i) => i)));

            c.curve_manager.notifyTreeUpdate();
            // Seed editor store with imported glyphs (like loadFromFile does after snapshot load)
            c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
            c.bumpEditorStoreTreeRevision?.();
            c.is_dirty = true;
        }

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
        const contentsStr = zip.file("font.ufo/glyphs/contents.plist")?.async?.("string");
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
            editor_guidelines: [],
            editor_sequence: "", editor_active_indices: [],
            family_name: fontSettings.family || "InkShader_Default_Font",
            project_name: projectName,
            basic_spacing: 1000,
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
        c.currentStateObj = c.history.getHistoryState();

        // Clear stale selection state (same pattern as loadFromFile in ProjectManager)
        c.curve_manager.clearAllSelection();
        c.curve_manager.activeGroupId = null;

        // 6. Import UFO glyphs
        const glyphNames = Object.keys(glyphMap);
        let glyphCount = 0;

        for (const glyphName of glyphNames) {
            const fileName = glyphMap[glyphName];
            const glifFile = zip.file(`font.ufo/glyphs/${fileName}`)
                || zip.file(`glyphs/${fileName}`);
            if (!glifFile) continue;

            const glifText = await glifFile.async("string");
            const result = this._importGLIF(glifText, glyphName, c);
            if (result) glyphCount++;
        }

        if (glyphCount > 0) {
            // ── Rebuild sequence state after importing glyphs ──
            // The empty snapshot load set up an empty sequence. Now we need to
            // register imported glyphs so the glyph menu finds them correctly
            // (prevents getDefaultGroupForChar from creating "A_1" duplicates).
            const seqService = c.curve_manager.seqService;
            const seqChars = [];
            for (const [id, item] of c.curve_manager.treeItems) {
                if (item.type === 'group' && item.parentId === null) {
                    // Unhide all imported root-level groups so they appear in menu
                    item.hidden_by_sequence = false;
                    if (item.charCode != null) seqChars.push(item.charCode);
                }
            }
            seqService.sequenceText = seqChars.join('');
            seqService._prevInTextIds = null;   // Force full sweep on next syncTreeWithSequence
            seqService.rebuildDefaultGlyphs();
            seqService.updateSequenceParsing();
            // Activate all sequence positions (all imported glyphs should be active)
            seqService.setActiveIndices(new Set(seqService.sequenceTokens.map((_, i) => i)));

            c.curve_manager.notifyTreeUpdate();
            // Seed editor store with imported glyphs (like loadFromFile does after snapshot load)
            c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
            c.bumpEditorStoreTreeRevision?.();
            c.is_dirty = true;
        }

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
     */
    _parseUFOFontInfo(xmlText) {
        const settings = {};
        const kvMatch = (re, key, transform = v => v) => {
            const m = xmlText.match(re);
            if (m) settings[key] = transform(m[1]);
        };

        kvMatch(/<key>familyName<\/key>\s*<string>([^<]*)<\/string>/, 'family');
        kvMatch(/<key>styleName<\/key>\s*<string>([^<]*)<\/string>/, 'style');
        kvMatch(/<key>unitsPerEm<\/key>\s*<integer>([^<]*)<\/integer>/, 'upm', v => parseInt(v, 10));
        kvMatch(/<key>ascender<\/key>\s*<integer>([^<]*)<\/integer>/, 'ascender', v => parseInt(v, 10));
        kvMatch(/<key>descender<\/key>\s*<integer>([^<]*)<\/integer>/, 'descender', v => parseInt(v, 10));
        kvMatch(/<key>capHeight<\/key>\s*<integer>([^<]*)<\/integer>/, 'cap_height', v => parseInt(v, 10));
        kvMatch(/<key>xHeight<\/key>\s*<integer>([^<]*)<\/integer>/, 'x_height', v => parseInt(v, 10));
        kvMatch(/<key>copyright<\/key>\s*<string>([^<]*)<\/string>/, 'copyright');
        kvMatch(/<key>postscriptFontName<\/key>\s*<string>([^<]*)<\/string>/, 'postscript_name');
        kvMatch(/<key>versionMajor<\/key>\s*<integer>([^<]*)<\/integer>/, 'versionMajor', v => parseInt(v, 10));
        kvMatch(/<key>versionMinor<\/key>\s*<integer>([^<]*)<\/integer>/, 'versionMinor', v => parseInt(v, 10));
        kvMatch(/<key>openTypeNameDesigner<\/key>\s*<string>([^<]*)<\/string>/, 'designer');
        kvMatch(/<key>openTypeNameDesignerURL<\/key>\s*<string>([^<]*)<\/string>/, 'designer_url');
        kvMatch(/<key>openTypeNameManufacturer<\/key>\s*<string>([^<]*)<\/string>/, 'manufacturer');
        kvMatch(/<key>openTypeNameManufacturerURL<\/key>\s*<string>([^<]*)<\/string>/, 'manufacturer_url');
        kvMatch(/<key>openTypeNameLicense<\/key>\s*<string>([^<]*)<\/string>/, 'license');
        kvMatch(/<key>openTypeNameLicenseURL<\/key>\s*<string>([^<]*)<\/string>/, 'license_url');
        kvMatch(/<key>openTypeNameVersion<\/key>\s*<string>([^<]*)<\/string>/, 'version');
        kvMatch(/<key>openTypeNameDescription<\/key>\s*<string>([^<]*)<\/string>/, 'description');
        kvMatch(/<key>openTypeNameSampleText<\/key>\s*<string>([^<]*)<\/string>/, 'sample_text');
        kvMatch(/<key>openTypeNamePreferredFamilyName<\/key>\s*<string>([^<]*)<\/string>/, 'preferred_family');
        kvMatch(/<key>openTypeNamePreferredSubfamilyName<\/key>\s*<string>([^<]*)<\/string>/, 'preferred_subfamily');
        kvMatch(/<key>openTypeOS2WeightClass<\/key>\s*<integer>([^<]*)<\/integer>/, 'weight_class', v => parseInt(v, 10));
        kvMatch(/<key>openTypeOS2WidthClass<\/key>\s*<integer>([^<]*)<\/integer>/, 'width_class', v => parseInt(v, 10));
        kvMatch(/<key>trademark<\/key>\s*<string>([^<]*)<\/string>/, 'trademark');
        // Custom InkShader field: preserve project_name through round-trip
        kvMatch(/<key>com\.inkshader\.projectName<\/key>\s*<string>([^<]*)<\/string>/, 'project_name');

        return settings;
    }

    /**
     * Parse UFO contents.plist → glyph name → filename mapping.
     */
    _parseUFOContents(xmlText) {
        const map = {};
        const re = /<key>\s*([^<]+?)\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/g;
        let m;
        while ((m = re.exec(xmlText)) !== null) {
            map[m[1]] = m[2];
        }
        return map;
    }

    /**
     * Import a single GLIF file: create group + curves from outline data.
     */
    _importGLIF(glifText, glyphName, c) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(glifText, 'text/xml');
        const glyphEl = doc.documentElement;
        if (!glyphEl || glyphEl.tagName !== 'glyph') return false;

        const name = glyphEl.getAttribute('name') || glyphName;
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
            if (hex) unicode = String.fromCharCode(parseInt(hex, 16));
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

        // Parse components → refs
        const h = c.canvas_size_height;
        for (const compEl of components) {
            const baseName = compEl.getAttribute('base');
            if (!baseName) continue;
            // Look up the target group by name
            const targetGroup = c.curve_manager.getGroupByName(baseName);
            if (!targetGroup) continue;
            // Read UFO-space transform attributes and convert to canvas Y-down space.
            // This is the inverse of the export transform in exportToUFO:
            //   ufoA=a, ufoB=-b, ufoC=-c, ufoD=d, ufoE=e+c*0.8h, ufoF=-f+0.8h-d*0.8h
            const ufoA = parseFloat(compEl.getAttribute('xScale')) || 1;
            const ufoB = parseFloat(compEl.getAttribute('xyScale')) || 0;
            const ufoC = parseFloat(compEl.getAttribute('yxScale')) || 0;
            const ufoD = parseFloat(compEl.getAttribute('yScale')) || 1;
            const ufoE = parseFloat(compEl.getAttribute('xOffset')) || 0;
            const ufoF = parseFloat(compEl.getAttribute('yOffset')) || 0;
            const matrix = new DOMMatrix([
                ufoA,           // a = ufoA
                -ufoB,          // b = -ufoB
                -ufoC,          // c = -ufoC
                ufoD,           // d = ufoD
                ufoE + ufoC * 0.8 * h,            // e = ufoE + ufoC * 0.8h
                0.8 * h - ufoD * 0.8 * h - ufoF   // f = 0.8h - ufoD*0.8h - ufoF
            ]);
            c.curve_manager.pasteGroupRef(targetGroup.id, groupId, matrix);
        }

        return true;
    }

    /**
     * Parse a GLIF <contour> element into an InkShader Curve.
     * Two-pass: first create vertex nodes, then attach control handles.
     */
    _parseGLIFContour(contourEl, c) {
        const ptEls = contourEl.querySelectorAll('point');
        if (ptEls.length < 2) return null;

        // UFO uses Y-up, canvas uses Y-down — flip Y to match canvas space.
        // The inverse of export's _fy(y) = 0.8 * canvasH - y.
        const canvasH = c.canvas_size_height;
        const flipY = (y) => 0.8 * canvasH - y;

        // Collect raw point data
        const pts = [];
        for (const el of ptEls) {
            pts.push({
                x: parseFloat(el.getAttribute('x')),
                y: flipY(parseFloat(el.getAttribute('y'))),
                type: el.getAttribute('type') || null
            });
        }

        // Find on-curve point indices
        const onCurveIdxs = [];
        for (let i = 0; i < pts.length; i++) {
            if (pts[i].type) onCurveIdxs.push(i);
        }
        if (onCurveIdxs.length < 2) return null;

        const curve = c.curve_manager.create_temp_curve();
        curve.closed = true;
        curve.stroke_width = 0;
        curve.smart_stroke = false;
        curve.show_skeleton = true;

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
            const entry = { marker, node };
            vertexData.push(entry);
            onCurveToVertex.set(idx, entry);
        }

        // PASS 2: Set control handles based on off-curve points between consecutive on-curves
        for (let s = 0; s < onCurveIdxs.length; s++) {
            const curIdx = onCurveIdxs[s];
            const nextIdx = onCurveIdxs[(s + 1) % onCurveIdxs.length];

            // Collect off-curve points between curIdx and nextIdx
            const offCurves = [];
            for (let j = curIdx + 1; j < nextIdx; j++) {
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
                    curNode.control_mode = curNode.control_mode || 1;
                }
                if (bcp2.x !== nextNode.x || bcp2.y !== nextNode.y) {
                    const c2Marker = generateMarker("circle");
                    const c2Node = new CurveNode(c2Marker, null, bcp2.x, bcp2.y, nextNode, null, String(c2Marker.id));
                    c2Node.curve = curve;
                    nextNode.control2 = c2Node;
                    curve.domMap.set(c2Marker, c2Node);
                    c.curve_manager.domMap.set(c2Marker, c2Node);
                    nextNode.control_mode = nextNode.control_mode || 1;
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

                curNode.control_mode = curNode.control_mode || 1;
                nextNode.control_mode = nextNode.control_mode || 1;
            }
            // 0 off-curves = straight line (no handles needed)
        }

        return curve;
    }

    /** Build SVG path d-attribute for a glyph (recursive, expands refs inline). */
    _buildGlyphSVGPaths(recorder, groupId, matrix) {
        const c = this.canvas;
        const grpItem = c.curve_manager.treeItems.get(groupId);
        if (!grpItem || !grpItem.children) return;

        for (const childId of grpItem.children) {
            const child = c.curve_manager.treeItems.get(childId);
            if (!child) continue;

            if (child.type === 'curve') {
                const curve = c.curve_manager.curveById.get(child.curveId);
                if (curve && curve.startNode && curve.visible !== false && curveGeneratesFillArea(curve)) {
                    appendCurveOutlinePath(recorder, curve, {
                        scale: 1, offsetX: 0, offsetY: 0, seqOffsetX: 0,
                        matrix: matrix || null
                    }, { pass: "fill" });
                }
            } else if (child.type === 'group') {
                if (child.isRef) {
                    // Always expand refs inline for SVG (no <use> / <component>)
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
        const canvasH = c.canvas_size_height;

        // Y-flip for font layer: same convention as UFO export
        // canvas Y=0 (top) → font Y = 0.8*canvasH (ascender line)
        // canvas Y=0.8*canvasH (baseline) → font Y = 0
        // canvas Y=canvasH (bottom) → font Y = -0.2*canvasH (descender)
        const fyFont = (y) => Math.round(0.8 * canvasH - y);
        const fyVis = (y) => Math.round(y);

        // SvgPathRecorder: accumulates commands for a single SVG path d="..."
        class SvgPathRecorder {
            constructor(fy) {
                this.parts = [];
                this._fy = fy || (v => Math.round(v));
            }
            moveTo(x, y) {
                this.parts.push(`M${Math.round(x)},${this._fy(y)}`);
            }
            lineTo(x, y) {
                this.parts.push(`L${Math.round(x)},${this._fy(y)}`);
            }
            bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
                this.parts.push(`C${Math.round(c1x)},${this._fy(c1y)} ${Math.round(c2x)},${this._fy(c2y)} ${Math.round(x)},${this._fy(y)}`);
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

        for (const rootChildId of (c.curve_manager.rootChildren || [])) {
            const item = c.curve_manager.treeItems.get(rootChildId);
            if (!item || item.isRef) continue;

            const glyphName = item.name;
            const advance = item.advance !== undefined ? item.advance : upm;

            // Build font-layer path (Y-up for FontForge)
            const fontRecorder = new SvgPathRecorder(fyFont);
            this._buildGlyphSVGPaths(fontRecorder, item.id, null);
            const fontD = fontRecorder.getD();

            // Build visual-layer path (canvas Y-down)
            const visRecorder = new SvgPathRecorder(fyVis);
            this._buildGlyphSVGPaths(visRecorder, item.id, null);
            const visD = visRecorder.getD();

            // ── Font layer glyph ──
            const advAttr = advance !== upm ? `\n         horiz-adv-x="${advance}"` : '';
            fontGlyphs += `      <glyph\n         glyph-name="${esc(glyphName)}"\n         ${getUnicodeAttr(item)}\n         id="glyph${glyphIndex}"${advAttr}\n         d="${esc(fontD)}" />\n`;

            // ── Visual layer group + path ──
            visualLayers += `    <g\n       inkscape:groupmode="layer"\n       id="layer${glyphIndex}"\n       inkscape:label="${getLayerLabel(item)}">\n      <path\n         style="fill:none;stroke:#ff0000;stroke-width:1"\n         id="path${glyphIndex}"\n         d="${esc(visD)}" />\n    </g>\n`;

            glyphIndex++;
        }

        const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const svgStr = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   width="${upm}"
   height="${upm}"
   viewBox="0 0 ${upm} ${upm}"
   version="1.1"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   data-project-name="${escAttr(fontSettings.project_name || '')}">
  <defs>
    <font
       horiz-adv-x="${upm}"
       id="font1"
       horiz-origin-x="0"
       horiz-origin-y="0">
      <font-face
         units-per-em="${upm}"
         ascent="${fontSettings.ascender}"
         cap-height="${fontSettings.cap_height || 0}"
         x-height="${fontSettings.x_height || 0}"
         descent="${fontSettings.descender}"
         font-family="${esc(fontSettings.family)}" />
      <missing-glyph
         d="M0,0h${upm}v${upm}h${-upm}z"
         id="missing-glyph1" />
${fontGlyphs}    </font>
  </defs>
  <g
     inkscape:groupmode="layer"
     id="layer${glyphIndex}"
     inkscape:label="${esc(fontSettings.family)}">
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
