import { appEventBus } from "../app/event_bus.js";
import { readRightPanelLayout } from "../app/layout_metrics_service.js";

// js/canvas/environment_adapter.js
export class EnvironmentAdapter {
    emitEvent(eventName, detail = null) {
        if (typeof window !== 'undefined') {
            appEventBus.emit(eventName, detail);
        }
    }

    listen(targetType, eventName, callback, options = false) {
        let target;
        if (typeof window === 'undefined') return () => {};
        
        if (targetType === 'window') {
            return appEventBus.on(eventName, callback, options);
        } else if (targetType === 'document') target = document;
        else if (targetType === 'body') target = document.body;
        else target = targetType;

        if (target && target.addEventListener) {
            target.addEventListener(eventName, callback, options);
            return () => target.removeEventListener(eventName, callback, options);
        }
        return () => {};
    }

    queryDOM(selector) {
        if (typeof document === 'undefined') return null;
        return document.querySelector(selector);
    }

    getDevicePixelRatio() {
        if (typeof window === "undefined") return 1;
        return window.devicePixelRatio || 1;
    }

    createDOMElement(tag) {
        if (typeof document === 'undefined') return {};
        return document.createElement(tag);
    }

    createSVGElement(tag) {
        if (typeof document === 'undefined') return {};
        return document.createElementNS("http://www.w3.org/2000/svg", tag);
    }

    getCanvasContext(canvas, type = "2d") {
        if (canvas && canvas.getContext) {
            return canvas.getContext(type);
        }
        return null;
    }

    revokeObjectURL(url) {
        if (typeof URL !== 'undefined') URL.revokeObjectURL(url);
    }

    createObjectURL(blob) {
        if (typeof URL !== 'undefined') return URL.createObjectURL(blob);
        return "";
    }

    getLocalStorage(key) {
        if (typeof localStorage !== 'undefined') return localStorage.getItem(key);
        return null;
    }

    getLocationHref() {
        if (typeof window !== 'undefined') return window.location.href;
        return "";
    }

    setActiveContext(context) {
        if (typeof window !== 'undefined') window.activeContext = context;
    }

    getActiveContext() {
        if (typeof window !== 'undefined') return window.activeContext;
        return 'canvas';
    }

    requestAnimationFrame(callback) {
        if (typeof window !== 'undefined') return window.requestAnimationFrame(callback);
        return setTimeout(callback, 16);
    }

    cancelAnimationFrame(id) {
        if (typeof window !== 'undefined') window.cancelAnimationFrame(id);
        else clearTimeout(id);
    }

    getExternalLayoutState() {
        const { rightWidth, treeFlex, propFlex } = readRightPanelLayout({
            rightContainer: this.queryDOM(".right"),
            objectTree: this.queryDOM("object-tree"),
            propertyPanel: this.queryDOM(".property_panel")
        });
        const dockLayout = window.__dock?.serialize?.() || null;
        return { rightWidth, treeFlex, propFlex, dockLayout };
    }
}