import { initializeLayoutShell } from "../ui/layout_shell.js";
import { ensureRuntimeHost } from "./canvas_host_wiring.js";

window.addEventListener("DOMContentLoaded", () => {
    ensureRuntimeHost();
    initializeLayoutShell();
});
