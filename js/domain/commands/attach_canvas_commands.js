import { CanvasCommands } from "./canvas_commands.js";

const commandMethodNames = Object.getOwnPropertyNames(CanvasCommands.prototype).filter(
    (name) => name !== "constructor"
);

/**
 * Command execution host: prototype methods (including _commitHistory) go through host, canvas state fields go through canvas.
 */
function createCommandHost(canvas) {
    const host = Object.create(CanvasCommands.prototype);
    Object.defineProperty(host, "_canvas", { value: canvas, enumerable: false });

    const commandHost = new Proxy(host, {
        get(target, prop, receiver) {
            if (prop === "_canvas") return canvas;
            if (prop === "commands") return receiver;
            if (commandMethodNames.includes(prop) && typeof target[prop] === "function") {
                return target[prop].bind(receiver);
            }
            if (typeof CanvasCommands.prototype[prop] === "function") {
                return CanvasCommands.prototype[prop].bind(receiver);
            }
            const v = canvas[prop];
            return typeof v === "function" ? v.bind(canvas) : v;
        },
        set(_target, prop, value) {
            // Canvas state must be written on canvas; interaction/rendering directly reads c.current_curve etc.
            if (commandMethodNames.includes(prop) && typeof host[prop] === "function") {
                return true;
            }
            canvas[prop] = value;
            return true;
        },
        has(_target, prop) {
            return prop in canvas || prop in CanvasCommands.prototype;
        }
    });

    for (const name of commandMethodNames) {
        const fn = CanvasCommands.prototype[name];
        if (typeof fn !== "function") continue;

        host[name] = (...args) => {
            const previous = canvas.__activeCommandName || null;
            canvas.__activeCommandName = name;
            try {
                const result = fn.apply(commandHost, args);
                if (result && typeof result.then === "function") {
                    return result.finally(() => {
                        canvas.__activeCommandName = previous;
                    });
                }
                canvas.__activeCommandName = previous;
                return result;
            } catch (error) {
                canvas.__activeCommandName = previous;
                throw error;
            }
        };
    }

    return commandHost;
}

/**
 * Command facade: mounted on canvas.commands, no longer spills dozens of methods onto the MainCanvas instance.
 */
export function attachCanvasCommands(canvas) {
    if (!canvas || canvas.__commandsAttached === true) return;

    canvas.commands = createCommandHost(canvas);
    canvas.__commandsAttached = true;
}
