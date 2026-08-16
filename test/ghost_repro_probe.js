// Ghost-object repro for UFO/SVG import paths:
// 1. Load baseline JSON (simulates prior project state)
// 2. Import the UFO export, then a fresh JSON reload, then the SVG export
// 3. Enumerate: root groups + hidden_by_sequence, sequence tokens, object tree DOM rows
// Compare with JSON import behavior (ghost fix reference).
//
// Expected after fix: after import (empty sequence), ALL root groups are
// hidden_by_sequence=true — tree matches the empty sequence, no ghosts.
// JSON reload stays consistent (hidden=[G] only).
export async function runGhostRepro() {
    const out = [];
    const log = (...a) => out.push(a.map(String).join(" "));

    const c = document.querySelector('main-canvas');
    const cm = c ? c.curve_manager : null;
    if (!cm) { log('NO CANVAS'); return out.join('\n'); }

    // Auto-accept confirm dialogs (cache overwrite) — patch INSIDE page
    // so no native dialog blocks the import flow.
    window.confirm = () => true;

    const snapshotTree = (label) => {
        const roots = [];
        for (const id of cm.rootChildren) {
            const item = cm.treeItems.get(id);
            if (item && item.type === 'group') {
                roots.push({
                    id, charCode: item.charCode ?? null, isRef: !!item.isRef,
                    hidden: !!item.hidden_by_sequence, isModified: !!item.is_modified,
                    children: (item.children || []).length
                });
            }
        }
        const tokens = (cm.seqService.sequenceTokens || []).map(t => t.isChar ? `<${t.value}>` : (t.name || t.value));
        log(label + ' roots=' + roots.length + ' hidden=[' + roots.filter(r => r.hidden).map(r => r.id).join(',') + '] tokens=[' + tokens.join(',') + ']');
        for (const r of roots) {
            log('  ' + (r.hidden ? 'HIDDEN ' : 'SHOWN  ') + r.id + ' char=' + (r.charCode ? JSON.stringify(r.charCode) : '-') + ' isRef=' + r.isRef + ' isMod=' + r.isModified + ' kids=' + r.children);
        }
        // object tree DOM rows
        const treeRows = Array.from(document.querySelectorAll('.tree_item')).map(el => el.dataset.id);
        log('  treeDOM rows=[' + treeRows.join(',') + ']');
    };

    // 1. load baseline JSON
    const json = await (await fetch('/test/InkShader_project_2026-08-02T16-27-25.json')).text();
    await c.projectManager.loadFromFile(json);
    await new Promise(r => setTimeout(r, 1200));
    snapshotTree('AFTER JSON LOAD');

    // 2. import UFO (session-4 original export; refs inlined but ghost issue independent of refs)
    const zipBuf = await (await fetch('/test/InkShader_export_2026-08-02T16-27-30.ufo.zip')).arrayBuffer();
    const JSZip = window.JSZip;
    const zip = await JSZip.loadAsync(zipBuf);
    const ok = await c.io._importUFOFromZip(zip);
    await new Promise(r => setTimeout(r, 1500));
    log('UFO import ok=' + ok);
    snapshotTree('AFTER UFO IMPORT');

    // 3. reload baseline JSON to reset state
    await c.projectManager.loadFromFile(json);
    await new Promise(r => setTimeout(r, 1200));
    snapshotTree('AFTER RELOAD JSON');

    // 4. import SVG export
    const svgText = await (await fetch('/test/InkShader_export_2026-08-02T16-27-33.svg')).text();
    const okSvg = await c.io._importSVGFontFromString(svgText);
    await new Promise(r => setTimeout(r, 1500));
    log('SVG import ok=' + okSvg);
    snapshotTree('AFTER SVG IMPORT');

    return out.join('\n');
}
