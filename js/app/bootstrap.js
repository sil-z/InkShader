import { initializeLayoutShell } from "../ui/layout_shell.js";
import { ensureRuntimeHost } from "./canvas_host_wiring.js";
import { initScrollbarVisibility } from "../services/scrollbar_visibility.js";

window.addEventListener("DOMContentLoaded", () => {
    ensureRuntimeHost();
    initializeLayoutShell();
    initScrollbarVisibility();
});
