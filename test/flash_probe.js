// Flash probe: during UFO import, poll the object tree DOM at high
// frequency to catch any transient appearance of imported glyphs.
// The sequence is empty on import, so glyphs must NEVER appear —
// they are created hidden_by_sequence=true from the start.
export async function runFlashProbe() {
    const out = [];
    const log = (...a) => out.push(a.map(String).join(" "));

    const c = document.querySelector('main-canvas');
    const cm = c ? c.curve_manager : null;
    if (!cm) { log('NO CANVAS'); return out.join('\n'); }
    window.confirm = () => true;

    // Start from a fresh empty project so any non-empty tree row during
    // import is a flash (no pre-existing glyph rows to confuse the probe).
    const emptySnapshot = JSON.stringify({ version: "1.0", editor_sequence: "", editor_active_indices: [], family_name: "FlashProbe", project_name: "FlashProbe", basic_spacing: 1000, font_style: "Regular", upm: 1000, editor_root_order: [], glyphs: {} });
    await c.commands.loadSnapshotCommand(emptySnapshot);
    await new Promise(r => setTimeout(r, 800));

    // Poll treeDOM every ~25ms while the import runs.
    const flashes = [];
    const rows = () => Array.from(document.querySelectorAll('.tree_item')).map(el => el.dataset.id);
    const pollId = setInterval(() => {
        const r = rows();
        if (r.length > 0) flashes.push(r.join(','));
    }, 25);

    const zipBuf = await (await fetch('/test/InkShader_export_2026-08-02T16-27-30.ufo.zip')).arrayBuffer();
    const zip = await window.JSZip.loadAsync(zipBuf);
    const ok = await c.io._importUFOFromZip(zip);

    clearInterval(pollId);
    await new Promise(r => setTimeout(r, 500));

    // Final state after import
    const hidden = [];
    for (const id of cm.rootChildren) {
        const item = cm.treeItems.get(id);
        if (item && item.type === 'group' && item.hidden_by_sequence) hidden.push(id);
    }
    const tokens = cm.seqService.sequenceTokens.length;
    log('import ok=' + ok);
    log('flashes during import=' + flashes.length + (flashes.length ? ' [' + flashes.slice(0, 5).join(' | ') + ']' : ''));
    log('final roots=' + cm.rootChildren.length + ' hidden=' + hidden.length + ' tokens=' + tokens + ' treeDOM rows=' + rows().length);

    return out.join('\n');
}
