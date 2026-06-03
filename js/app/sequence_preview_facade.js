/**
 * 序列缩略图（presentation + CM）；仅供 editor_read_facade 调用，UI 不得 import presentation。
 */
import { drawSequenceGroupPreview } from "../presentation/sequence/sequence_group_preview.js";
import { getMainCanvasFromDocument } from "./canvas_access.js";

export function drawSequenceGroupPreviewOnContext(ctx, groupId) {
    if (!ctx || !groupId) return;
    const cm = getMainCanvasFromDocument()?.curve_manager;
    if (!cm) return;
    drawSequenceGroupPreview(ctx, cm, groupId);
}
