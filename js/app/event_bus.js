/**
 * Low-level transport: CustomEvent on window.
 * For write intent, use CanvasDispatcher; for reading state, subscribe to STATE_CHANGED and other domain/Store events.
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
