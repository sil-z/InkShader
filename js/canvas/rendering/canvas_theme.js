/**
 * 画布呈现主题（仅 canvas / UI 层使用，领域 core 不依赖）。
 */
import { param_set, updateThemeParams } from "../../services/theme.js";

export { param_set, updateThemeParams };

export function getCanvasTheme() {
    return param_set["1"];
}
