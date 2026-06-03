// js/core/transform_engine.js

export class TransformEngine {
    /**
     * 计算拖拽时的局部坐标偏移量 (包含矩阵反解逻辑)
     * @returns {Object} { local_dx, local_dy }
     */
    static calculateLocalDelta(screenDx, screenDy, scale, matrix) {
        let logic_dx = screenDx / scale;
        let logic_dy = screenDy / scale;
        
        if (!matrix) {
            return { local_dx: logic_dx, local_dy: logic_dy };
        }
        
        // 矩阵逆变换计算真实局部坐标增量
        let inv = matrix.inverse();
        let pt0 = inv.transformPoint({x: 0, y: 0});
        let pt1 = inv.transformPoint({x: logic_dx, y: logic_dy});
        
        return {
            local_dx: pt1.x - pt0.x,
            local_dy: pt1.y - pt0.y
        };
    }

    /**
     * 纯函数：计算基于快照的节点组整体平移结果
     * @param {Map} initialNodesMap - mousedown时保存的快照 (drag_initial_nodes)
     * @param {Number} actual_dx - 经过吸附修正后的真实 X 位移
     * @param {Number} actual_dy - 经过吸附修正后的真实 Y 位移
     * @returns {Array} 包含需要更新的节点数据的数组指令
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
            
            // 绝对坐标系的控制点平移
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
    // [新增] 变换 (Transform) 相关的纯计算引擎 (针对 handleMouseMoveTransforming)
    // =========================================================================

    /**
     * 纯函数：计算旋转角度及三角函数参数
     */
    static calculateRotationParams(pivot, startWorld, currentWorld, isCtrlPressed) {
        let startAngle = Math.atan2(startWorld.y - pivot.y, startWorld.x - pivot.x);
        let currentAngle = Math.atan2(currentWorld.y - pivot.y, currentWorld.x - pivot.x);
        let angleDeg = (currentAngle - startAngle) * 180 / Math.PI;
        
        // Ctrl 键开启 5 度吸附
        if (isCtrlPressed) angleDeg = Math.round(angleDeg / 5) * 5; 
        
        let angle = angleDeg * Math.PI / 180;
        return {
            angleDeg,
            cos: Math.cos(angle),
            sin: Math.sin(angle)
        };
    }

    /**
     * 纯函数：计算基于各个控制柄的缩放比例
     */
    static calculateScaleParams(action, pivot, startWorld, currentWorld, keepRatio) {
        let sx = 1, sy = 1;
        let startW = startWorld.x - pivot.x;
        let startH = startWorld.y - pivot.y;
        let currW = currentWorld.x - pivot.x; 
        let currH = currentWorld.y - pivot.y;
        
        if (Math.abs(startW) > 0.01 && ['tl', 'tr', 'bl', 'br', 'ml', 'mr'].includes(action)) sx = currW / startW;
        if (Math.abs(startH) > 0.01 && ['tl', 'tr', 'bl', 'br', 'tc', 'bc'].includes(action)) sy = currH / startH;
        
        // 保持等比缩放
        if (keepRatio && ['tl', 'tr', 'bl', 'br'].includes(action)) {
            let maxScale = Math.max(Math.abs(sx), Math.abs(sy));
            sx = maxScale * Math.sign(sx); 
            sy = maxScale * Math.sign(sy);
        }
        return { sx, sy };
    }

    /**
     * 纯函数：将计算出的变换参数应用到单个节点的坐标和其附带偏移系上
     */
    static applyTransformationToPoint(pt, snap, action, pivot, params) {
        if (snap && snap.localToWorld && snap.worldToLocal) {
            const worldPt = snap.localToWorld.transformPoint({ x: pt.x, y: pt.y });
            let newGlobalX, newGlobalY;

            if (action === 'rot') {
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
        
        if (action === 'rot') {
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