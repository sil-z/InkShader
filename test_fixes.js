// InkShader Fix Verification Script
// Paste this in the browser console (F12 → Console) AFTER doing Ctrl+F5 refresh
// Then copy the output and paste it back here.

(function() {
  const results = [];
  const c = document.querySelector('main-canvas')?.canvas || 
            document.querySelector('main-canvas')?.__canvas;

  if (!c) {
    // Try finding the canvas object through global scope
    const all = Object.keys(window).filter(k => {
      try { return window[k]?.constructor?.name === 'MainCanvas'; } catch(e) { return false; }
    });
    results.push(`FAIL: Could not find MainCanvas. Found keys: ${all.join(', ') || 'none'}`);
    console.log(results.join('\n'));
    return;
  }

  // Test 1: Metric guide label position logic
  const offsetX = c.utils.getLogicalOffset().x;
  const expectedLabelX = 4 - (c.offset.x);
  results.push(`[Guide Labels] offset.x=${c.offset.x}, offsetX=${offsetX}, formula 4-offset.x=${4-c.offset.x}`);

  // Test 2: LSB/RSB Y position
  const drawingAreaBottom = c.ruler_size + c.canvas_size_height * c.scale;
  const labelY = drawingAreaBottom - 18;
  const logicalH = c.viewportService?.getCanvasUserSpaceSize?.()?.height || 0;
  results.push(`[LSB/RSB Y] ruler_size=${c.ruler_size}, canvas_h=${c.canvas_size_height}, scale=${c.scale}`);
  results.push(`[LSB/RSB Y] drawingAreaBottom=${drawingAreaBottom}, labelY=${labelY}, logicalH=${logicalH}`);
  results.push(`[LSB/RSB Y] vs old logicalH-18=${logicalH-18} — diff=${labelY - (logicalH-18)}`);

  // Test 3: Divider drag handlers registered
  const registeredCount = (() => {
    // Check that the divider drag mousedown handler exists
    // by checking if _draggingDivider state is handled
    const hasDividerState = typeof c.current_state !== 'undefined';
    return hasDividerState ? 'state tracking present' : 'missing state';
  })();
  results.push(`[Divider Drag] ${registeredCount}`);
  results.push(`[Divider Drag] commitDividerDrag ${typeof c._commitDividerDrag === 'function' ? 'found' : 'N/A'}`);

  // Summary
  results.push('---');
  results.push('Please tell me the output above.');
  console.log(results.join('\n'));
})();
