import { CanvasCommands } from "./canvas_commands.js";

const commandMethodNames = Object.getOwnPropertyNames(CanvasCommands.prototype).filter(
    (name) => name !== "constructor"
);

/**
 * 命令执行宿主：原型方法（含 _commitHistory）走 host，画布状态字段走 canvas。
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
            // 画布状态必须写在 canvas 上；交互/渲染直接读 c.current_curve 等字段
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
 * 命令门面：挂在 canvas.commands，不再把数十个方法铺到 MainCanvas 实例上。
 */
export function attachCanvasCommands(canvas) {
    if (!canvas || canvas.__commandsAttached === true) return;

    canvas.commands = createCommandHost(canvas);
    canvas.__commandsAttached = true;
}
