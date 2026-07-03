/**
 * Canvas rendering theme (canvas / UI layer only; domain core does not depend on it).
 */
import { param_set, updateThemeParams } from "../../services/theme.js";

export { param_set, updateThemeParams };

export function getCanvasTheme() {
    return param_set["1"];
}
