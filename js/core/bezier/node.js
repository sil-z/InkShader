// js/core/bezier/node.js — Domain node geometry (rendering in canvas/rendering/node_renderer.js)
import { generateMarker } from './utils.js';
import { CurveStore } from './curve_store.js';

export class CurveNode {
    curve = null;
    main_node; type; x; y;
    nextOnCurve; lastOnCurve; control1 = null; control2 = null;
    smooth = false; end_node = false; start_node = false;
    control_mode = 2; synmove_mode = 1; node_id;
    last_touched = 0; 

    constructor(main_node, type, x, y, nextOnCurve, lastOnCurve, node_id) {
        this.main_node = main_node; this.type = type; this.x = x; this.y = y;
        this.lastOnCurve = lastOnCurve; this.nextOnCurve = nextOnCurve; this.node_id = node_id;
    }

    applyMode(mode, manager) {
        this.control_mode = mode;
        if (mode === 0) return; 

        if (mode > 0 && (!this.control1 || !this.control2)) {
            let vx = 30, vy = 0; 
            if (this.lastOnCurve && this.nextOnCurve) {
                let dx = this.nextOnCurve.x - this.lastOnCurve.x; let dy = this.nextOnCurve.y - this.lastOnCurve.y;
                let len = Math.hypot(dx, dy);
                if (len > 1e-5) { vx = (dx/len)*30; vy = (dy/len)*30; }
            } else if (this.lastOnCurve) {
                let dx = this.x - this.lastOnCurve.x; let dy = this.y - this.lastOnCurve.y;
                let len = Math.hypot(dx, dy);
                if (len > 1e-5) { vx = (dx/len)*30; vy = (dy/len)*30; }
            } else if (this.nextOnCurve) {
                let dx = this.nextOnCurve.x - this.x; let dy = this.nextOnCurve.y - this.y;
                let len = Math.hypot(dx, dy);
                if (len > 1e-5) { vx = (dx/len)*30; vy = (dy/len)*30; }
            }

            if (!this.control1 && manager) {
                let m1 = generateMarker("circle");
                this.control1 = new CurveNode(m1, null, this.x - vx, this.y - vy, this, null, m1.id);
                this.control1.curve = this.curve; 
                manager.domMap.set(m1, this.control1);
                this.curve.domMap.set(m1, this.control1);
            }
            if (!this.control2 && manager) {
                let m2 = generateMarker("circle");
                this.control2 = new CurveNode(m2, null, this.x + vx, this.y + vy, this, null, m2.id);
                this.control2.curve = this.curve; 
                manager.domMap.set(m2, this.control2);
                this.curve.domMap.set(m2, this.control2);
            }
        }

        if (!this.control1 || !this.control2) return; 

        let vx = this.control1.x - this.x; let vy = this.control1.y - this.y;
        let len1 = Math.hypot(vx, vy);
        let ox = this.control2.x - this.x; let oy = this.control2.y - this.y;
        let len2 = Math.hypot(ox, oy);

        if (len1 < 1e-5 && len2 < 1e-5) return; 

        if (len1 < 1e-5) {
            let ux = ox / len2; let uy = oy / len2;
            let forceLen = mode === 2 ? len2 : 30;
            this.control1.x = this.x - ux * forceLen; this.control1.y = this.y - uy * forceLen;
            return;
        }

        let ux = vx / len1; let uy = vy / len1;

        if (mode === 2) { 
            this.control2.x = this.x - ux * len1; this.control2.y = this.y - uy * len1;
        } else if (mode === 1) { 
            let targetLen2 = len2 > 1e-5 ? len2 : len1; 
            this.control2.x = this.x - ux * targetLen2; this.control2.y = this.y - uy * targetLen2;
        }
    }

    _resolveNodeByMarker(main_node) {
        if (this.curve) {
            const onCurve = this.curve.find_node_by_dom(main_node);
            if (onCurve) return onCurve;
        }
        const store = CurveStore.resolveActive() ?? CurveStore.getInstance();
        return store.find_node_by_curve(main_node);
    }

    set_both_control(one_control, control_mode) {
        let other_control = (this.control1?.main_node === one_control) ? this.control2 : this.control1;
        let one_control_n = this._resolveNodeByMarker(one_control);
        if(!other_control || !one_control_n) return;

        if(control_mode === 2) {
            other_control.x = 2 * this.x - one_control_n.x;
            other_control.y = 2 * this.y - one_control_n.y;
        } 
        else if (control_mode === 1) {
            let vx = one_control_n.x - this.x; let vy = one_control_n.y - this.y;
            let len1 = Math.hypot(vx, vy);
            let ox = other_control.x - this.x; let oy = other_control.y - this.y;
            let len2 = Math.hypot(ox, oy);

            if (len1 > 1e-5 && len2 > 1e-5) {
                let ux = vx / len1; let uy = vy / len1;
                other_control.x = this.x - ux * len2;
                other_control.y = this.y - uy * len2;
            }
        }
    }

    sync_control_with_main(dx, dy, logic_dx, logic_dy, synmove_mode) {
        if(this.synmove_mode === 0 && synmove_mode === 0) return;
        if(this.control1 !== null) { this.control1.x += logic_dx; this.control1.y += logic_dy; }
        if(this.control2 !== null) { this.control2.x += logic_dx; this.control2.y += logic_dy; }
    }

    sync_selected(dx, dy, logic_dx, logic_dy, node_list) {
        for(const node of node_list) {
            const node_n = this._resolveNodeByMarker(node);
            if(node_n) {
                node_n.sync_control_with_main(dx, dy, logic_dx, logic_dy, 0);
                node_n.x += logic_dx; node_n.y += logic_dy;
            }
        }
    }
}