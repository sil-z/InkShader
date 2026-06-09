import { CanvasDispatcher } from "../../app/canvas_dispatcher.js";
import { appendCurveOutlinePath, curveGeneratesFillArea } from "../rendering/curve_renderer.js";
import { getCanvasTheme } from "../rendering/canvas_theme.js";
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
    save_file() {
        const c = this.canvas;
        return c.curve_manager.exportJSON({
            canvas_size_width: c.canvas_size_width,
            canvas_size_height: c.canvas_size_height,
            guidelines_h: c.active_guidelines.filter((g) => g.type === "h").map((g) => g.value),
            guidelines_v: c.active_guidelines.filter((g) => g.type === "v").map((g) => g.value),
            guideline_lock: c.guideline_lock,
            user_guidelines: c.user_guidelines || [],
            fill_color: getCanvasTheme().path_fill_color,
            stroke_color: getCanvasTheme().path_stroke_color
        });
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
                try {
                    await c.commands.loadSnapshotCommand(jsonStr);
                    c.commandStack = [];
                    c.redoCommandStack = [];
                    c.currentStateObj = c.history.getHistoryState();
                    if (typeof c.history._flushRuntimeStateSave === "function") c.history._flushRuntimeStateSave();
                    c.history.saveCurrentViewState(true);
                    console.log("[CommandDebug] loaded snapshot from file");
                    c.notifyPropertiesUpdate();
                    c.is_dirty = true;
                    c.editorStore?.seedFromCanvas?.({ applyToRuntime: true });
                } catch (err) {
                    alert("Critical error during file loading: " + err.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }
    triggerSave() {
        const c = this.canvas;
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
        console.log("[CommandDebug] manual save snapshot persisted");
    }
    exportToUFO() {
        const c = this.canvas;
        if (typeof JSZip === "undefined") {
            alert("JSZip library is not loaded. Cannot export UFO.");
            return;
        }
        let fontSettings = { family: "InkShader Font", style: "Regular", upm: 1000, ascender: 800, descender: -200, version: "1.0" };
        try {
            const prefs = JSON.parse(c.env.getLocalStorage("InkShader_preferences") || "{}");
            if (prefs.fontSettings) fontSettings = { ...fontSettings, ...prefs.fontSettings };
        } catch (e) {}
        let [vMaj, vMin] = fontSettings.version.split(".");
        vMaj = parseInt(vMaj, 10) || 1;
        vMin = parseInt(vMin, 10) || 0;
        const zip = new JSZip();
        const ufoFolder = zip.folder("font.ufo");
        const glyphsFolder = ufoFolder.folder("glyphs");
        ufoFolder.file("fontinfo.plist", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>ascender</key><integer>${fontSettings.ascender}</integer>
    <key>descender</key><integer>${fontSettings.descender}</integer>
    <key>familyName</key><string>${fontSettings.family}</string>
    <key>styleName</key><string>${fontSettings.style}</string>
    <key>unitsPerEm</key><integer>${fontSettings.upm}</integer>
    <key>versionMajor</key><integer>${vMaj}</integer>
    <key>versionMinor</key><integer>${vMin}</integer>
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
        class GlifRecorder {
            constructor(canvasHeight) {
                this.contours = [];
                this.currentContour = null;
                this.h = canvasHeight;
            }
            _fy(y) { return this.h - y; }
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
            getXML() {
                this._flushContour();
                let xml = "";
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
        for (const [id, item] of c.curve_manager.treeItems.entries()) {
            if (item.type === "group" && !item.isRef && item.charCode !== null && item.charCode !== undefined) {
                const glyphName = item.name;
                const fileName = `${glyphName}.glif`;
                const hexCode = item.charCode.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase();
                const unicodeTag = `<unicode hex="${hexCode}"/>`;
                const advance = item.advance !== undefined ? item.advance : 1000;
                contentsDict += `    <key>${glyphName}</key>\n    <string>${fileName}</string>\n`;
                const recorder = new GlifRecorder(c.canvas_size_height);
                const curveDataList = c.curve_manager.getCurvesForGroup(item.id);
                for (const cd of curveDataList) {
                    if (cd.curve?.startNode && cd.curve.visible !== false && curveGeneratesFillArea(cd.curve)) {
                        appendCurveOutlinePath(recorder, cd.curve, {
                            scale: 1,
                            offsetX: 0,
                            offsetY: 0,
                            seqOffsetX: 0,
                            matrix: cd.matrix
                        }, { pass: "fill" });
                    }
                }
                const glifXML = `<?xml version="1.0" encoding="UTF-8"?>
<glyph name="${glyphName}" format="2">
  <advance width="${advance}"/>
  ${unicodeTag}
  <outline>\n${recorder.getXML()}  </outline>\n</glyph>`;
                glyphsFolder.file(fileName, glifXML);
            }
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
}
