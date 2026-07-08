// js/core/transform_engine.js

export class TransformEngine {
    /**
     * Computes local coordinate offset during drag (including matrix inverse logic)
     * @returns {Object} { local_dx, local_dy }
     */
    static calculateLocalDelta(screenDx, screenDy, scale, matrix) {
        let logic_dx = screenDx / scale;
        let logic_dy = screenDy / scale;
        
        if (!matrix) {
            return { local_dx: logic_dx, local_dy: logic_dy };
        }
        
        // Inverse matrix transform to compute actual local coordinate delta
        let inv = matrix.inverse();
        let pt0 = inv.transformPoint({x: 0, y: 0});
        let pt1 = inv.transformPoint({x: logic_dx, y: logic_dy});
        
        return {
            local_dx: pt1.x - pt0.x,
            local_dy: pt1.y - pt0.y
        };
    }

    /**
     * Pure function: computes node group translation based on snapshot
     * @param {Map} initialNodesMap - snapshot saved at mousedown (drag_initial_nodes)
     * @param {Number} actual_dx - actual X displacement after snap correction
     * @param {Number} actual_dy - actual Y displacement after snap correction
     * @returns {Array} array of instruction objects containing node data to update
     */
    static calculateNodesTranslation(initialNodesMap, actual_dx, actual_dy) {
        const updates = [];
        for (const [marker, init_pos] of initialNodesMap.entries()) {
            const update = {
                marker: marker,
                x: init_pos.x + actual_dx,
                y: init_pos.y + actual_dy,
                control1: null,
                control2: null
            };
            
            // Control point translation in absolute coordinate system
            if (init_pos.c1x !== undefined) {
                update.control1 = {
                    x: init_pos.c1x + actual_dx,
                    y: init_pos.c1y + actual_dy
                };
            }
            if (init_pos.c2x !== undefined) {
                update.control2 = {
                    x: init_pos.c2x + actual_dx,
                    y: init_pos.c2y + actual_dy
                };
            }
            updates.push(update);
        }
        return updates;
    }

    // =========================================================================
    // [New] Transform-related pure computation engine (for handleMouseMoveTransforming)
    // =========================================================================

    /**
     * Pure function: computes rotation angle and trigonometric parameters
     */
    static calculateRotationParams(pivot, startWorld, currentWorld, isCtrlPressed) {
        let startAngle = Math.atan2(startWorld.y - pivot.y, startWorld.x - pivot.x);
        let currentAngle = Math.atan2(currentWorld.y - pivot.y, currentWorld.x - pivot.x);
        let angleDeg = (currentAngle - startAngle) * 180 / Math.PI;
        
        // Ctrl key enables 5-degree snap
        if (isCtrlPressed) angleDeg = Math.round(angleDeg / 5) * 5; 
        
        let angle = angleDeg * Math.PI / 180;
        return {
            angleDeg,
            cos: Math.cos(angle),
            sin: Math.sin(angle)
        };
    }

    /**
     * Pure function: computes scale ratio based on each handle
     */
    static calculateScaleParams(action, pivot, startWorld, currentWorld, keepRatio) {
        let sx = 1, sy = 1;
        let startW = startWorld.x - pivot.x;
        let startH = startWorld.y - pivot.y;
        let currW = currentWorld.x - pivot.x; 
        let currH = currentWorld.y - pivot.y;
        
        if (Math.abs(startW) > 0.01 && ['tl', 'tr', 'bl', 'br', 'ml', 'mr'].includes(action)) sx = currW / startW;
        if (Math.abs(startH) > 0.01 && ['tl', 'tr', 'bl', 'br', 'tc', 'bc'].includes(action)) sy = currH / startH;
        
        // Keep aspect ratio scaling
        if (keepRatio && ['tl', 'tr', 'bl', 'br'].includes(action)) {
            let maxScale = Math.max(Math.abs(sx), Math.abs(sy));
            sx = maxScale * Math.sign(sx); 
            sy = maxScale * Math.sign(sy);
        }
        return { sx, sy };
    }

    /**
     * Pure function: computes shear parameters based on handle type and mouse delta
     *
     * @param {string} action - "shear_tc" | "shear_bc" | "shear_ml" | "shear_mr"
     * @param {object} pivot - { x, y } pivot point in world coords
     * @param {object} startWorld - { x, y } mouse start position
     * @param {object} currentWorld - { x, y } current mouse position
     * @param {object} bounds - { minX, minY, maxX, maxY } selection bounds
     * @returns {{ shx: number, shy: number }} shear factors
     */
    static calculateShearParams(action, pivot, startWorld, currentWorld, bounds) {
        let shx = 0, shy = 0;
        const h = bounds.maxY - bounds.minY;
        const w = bounds.maxX - bounds.minX;
        const dx = currentWorld.x - startWorld.x;
        const dy = currentWorld.y - startWorld.y;

        switch (action) {
            case 'shear_bc':
                // Bottom edge: drag right → top moves left (positive shx)
                if (h > 0.01) shx = dx / h;
                break;
            case 'shear_tc':
                // Top edge: drag right → bottom moves left (negative shx, opposite to shear_bc)
                if (h > 0.01) shx = -dx / h;
                break;
            case 'shear_mr':
                // Right edge: drag up → left moves down (positive shy)
                if (w > 0.01) shy = dy / w;
                break;
            case 'shear_ml':
                // Left edge: drag up → right moves down (negative shy, opposite to shear_mr)
                if (w > 0.01) shy = -dy / w;
                break;
        }
        return { shx, shy };
    }

    /**
     * Pure function: applies shear transformation to a point
     */
    static applyShearToPoint(pt, snap, action, pivot, params) {
        // Shear matrix: [1, shy, shx, 1, 0, 0]
        const shx = params.shx || 0;
        const shy = params.shy || 0;

        if (snap && snap.localToWorld && snap.worldToLocal) {
            const worldPt = snap.localToWorld.transformPoint({ x: pt.x, y: pt.y });
            const dx = worldPt.x - pivot.x;
            const dy = worldPt.y - pivot.y;
            const newGlobalX = pivot.x + dx + shx * dy;
            const newGlobalY = pivot.y + dy + shy * dx;
            const localPt = snap.worldToLocal.transformPoint({ x: newGlobalX, y: newGlobalY });
            return { x: localPt.x, y: localPt.y };
        }

        let globalX = pt.x + snap.seqOff + snap.refTx;
        let globalY = pt.y + snap.refTy;
        const dx = globalX - pivot.x;
        const dy = globalY - pivot.y;
        const newGlobalX = pivot.x + dx + shx * dy;
        const newGlobalY = pivot.y + dy + shy * dx;

        return {
            x: newGlobalX - snap.seqOff - snap.refTx,
            y: newGlobalY - snap.refTy
        };
    }

    /**
     * Pure function: applies computed transform parameters to a single node's coordinates and its offset system.
     * Supports 'rot', 'scale' (sx/sy), and 'shear' (shx/shy) actions.
     */
    static isRotateAction(action) {
        return action === 'rot' || action === 'rot_tl' || action === 'rot_tr' || action === 'rot_bl' || action === 'rot_br';
    }

    static applyTransformationToPoint(pt, snap, action, pivot, params) {
        // Delegate shear to dedicated method
        if (action === 'shear_tc' || action === 'shear_bc' || action === 'shear_ml' || action === 'shear_mr') {
            return TransformEngine.applyShearToPoint(pt, snap, action, pivot, params);
        }

        if (snap && snap.localToWorld && snap.worldToLocal) {
            const worldPt = snap.localToWorld.transformPoint({ x: pt.x, y: pt.y });
            let newGlobalX, newGlobalY;

            if (TransformEngine.isRotateAction(action)) {
                let rx = worldPt.x - pivot.x;
                let ry = worldPt.y - pivot.y;
                newGlobalX = pivot.x + rx * params.cos - ry * params.sin;
                newGlobalY = pivot.y + rx * params.sin + ry * params.cos;
            } else {
                newGlobalX = pivot.x + (worldPt.x - pivot.x) * params.sx;
                newGlobalY = pivot.y + (worldPt.y - pivot.y) * params.sy;
            }

            const localPt = snap.worldToLocal.transformPoint({ x: newGlobalX, y: newGlobalY });
            return { x: localPt.x, y: localPt.y };
        }

        let globalX = pt.x + snap.seqOff + snap.refTx;
        let globalY = pt.y + snap.refTy;
        let newGlobalX, newGlobalY;
        
        if (TransformEngine.isRotateAction(action)) {
            let rx = globalX - pivot.x;
            let ry = globalY - pivot.y;
            newGlobalX = pivot.x + rx * params.cos - ry * params.sin;
            newGlobalY = pivot.y + rx * params.sin + ry * params.cos;
        } else {
            newGlobalX = pivot.x + (globalX - pivot.x) * params.sx;
            newGlobalY = pivot.y + (globalY - pivot.y) * params.sy;
        }
        
        return { 
            x: newGlobalX - snap.seqOff - snap.refTx, 
            y: newGlobalY - snap.refTy 
        };
    }
}