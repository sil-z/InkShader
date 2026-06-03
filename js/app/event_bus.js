/**
 * 底层传输：window 上的 CustomEvent。
 * 写意图请用 CanvasDispatcher；读状态请订阅 STATE_CHANGED 等领域/Store 事件。
 */
export class EventBus {
    constructor(target = window) {
        this.target = target;
    }

    emit(eventName, detail = {}) {
        const event = new CustomEvent(eventName, { detail });
        this.target.dispatchEvent(event);
        return event;
    }

    on(eventName, listener, options = false) {
        this.target.addEventListener(eventName, listener, options);
        return () => this.target.removeEventListener(eventName, listener, options);
    }

    request(eventName, detail = {}) {
        const event = this.emit(eventName, detail);
        return event.detail;
    }
}

export const appEventBus = new EventBus(window);
