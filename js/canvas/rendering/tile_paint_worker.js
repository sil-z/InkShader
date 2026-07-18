/**
 * Tile paint Worker — holds a scene snapshot; paint jobs only send tile coords.
 */
import { paintTilePaths } from "./tile_paint_core.js";

/** @type {{ epoch:string, items:object[], theme:object }|null} */
let scene = null;
let sceneBuild = null;

function itemWorldBounds(item) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x, y) => {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    };
    const applyMatrix = (x, y, m) => {
        if (!m) return { x, y };
        return {
            x: x * m.a + y * m.c + m.e,
            y: x * m.b + y * m.d + m.f
        };
    };
    const consider = (x, y) => {
        const p = applyMatrix(x, y, item.matrix);
        add(p.x + (item.seqOffsetX || 0), p.y);
    };
    if (item.boolean?.length) {
        for (const sub of item.boolean) {
            for (const s of sub.segments || []) consider(s.x, s.y);
        }
    } else {
        for (const seg of item.skeleton || []) {
            consider(seg.p0.x, seg.p0.y);
            consider(seg.p1.x, seg.p1.y);
            consider(seg.p2.x, seg.p2.y);
            consider(seg.p3.x, seg.p3.y);
        }
    }
    if (!Number.isFinite(minX)) return null;
    const pad = (item.stroke_width || 0) + 2;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function itemsForWorldRect(world) {
    if (!scene?.items?.length) return [];
    const out = [];
    for (const item of scene.items) {
        const b = item._wb || (item._wb = itemWorldBounds(item));
        if (!b) continue;
        if (b.maxX < world.minX || b.minX > world.maxX || b.maxY < world.minY || b.minY > world.maxY) {
            continue;
        }
        out.push(item);
    }
    return out;
}

self.onmessage = async (ev) => {
    const msg = ev.data;
    if (!msg) return;

    if (msg.type === "setScene") {
        scene = {
            epoch: msg.epoch,
            items: msg.items || [],
            theme: msg.theme || {}
        };
        // Precompute bounds once.
        for (const item of scene.items) item._wb = itemWorldBounds(item);
        self.postMessage({ type: "sceneReady", epoch: msg.epoch, count: scene.items.length });
        return;
    }

    if (msg.type === "beginScene") {
        scene = null;
        sceneBuild = {
            epoch: msg.epoch,
            items: [],
            theme: msg.theme || {}
        };
        return;
    }

    if (msg.type === "appendScene") {
        if (!sceneBuild || sceneBuild.epoch !== msg.epoch) return;
        for (const item of msg.items || []) {
            item._wb = itemWorldBounds(item);
            sceneBuild.items.push(item);
        }
        return;
    }

    if (msg.type === "commitScene") {
        if (!sceneBuild || sceneBuild.epoch !== msg.epoch) return;
        scene = sceneBuild;
        sceneBuild = null;
        self.postMessage({ type: "sceneReady", epoch: scene.epoch, count: scene.items.length });
        return;
    }

    if (msg.type === "clearScene") {
        scene = null;
        sceneBuild = null;
        return;
    }

    if (msg.type !== "paint") return;

    const { key, cssSize, dpr, scale, offsetX, offsetY, world, epoch } = msg;
    try {
        if (!scene || scene.epoch !== epoch) {
            self.postMessage({ type: "error", key, error: "no-scene" });
            return;
        }
        const items = itemsForWorldRect(world);
        const w = Math.max(1, Math.round(cssSize * dpr));
        const h = Math.max(1, Math.round(cssSize * dpr));
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            self.postMessage({ type: "error", key, error: "no-2d" });
            return;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintTilePaths(ctx, {
            scale,
            offsetX,
            offsetY,
            items,
            theme: scene.theme,
            cssSize
        });
        const bitmap = canvas.transferToImageBitmap();
        self.postMessage({ type: "done", key, bitmap, cssSize, dpr, scale }, [bitmap]);
    } catch (err) {
        self.postMessage({
            type: "error",
            key,
            error: String(err?.message || err)
        });
    }
};
