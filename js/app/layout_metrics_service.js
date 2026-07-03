/**
 * Sidebar / right-panel layout metrics (task E): centralize getBoundingClientRect for layout and view-state persistence.
 */

export function readElementRect(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") {
        return { width: 0, height: 0, left: 0, top: 0 };
    }
    const r = element.getBoundingClientRect();
    return { width: r.width, height: r.height, left: r.left, top: r.top };
}

/**
 * @returns {{ rightWidth: number, treeFlex: number, propFlex: number, treeHeight: number, propHeight: number, totalDynamicHeight: number }}
 */
export function readRightPanelLayout({
    rightContainer = null,
    objectTree = null,
    propertyPanel = null
} = {}) {
    const right = rightContainer || (typeof document !== "undefined" ? document.querySelector(".right") : null);
    const tree = objectTree || (typeof document !== "undefined" ? document.querySelector("object-tree") : null);
    const prop =
        propertyPanel || (typeof document !== "undefined" ? document.querySelector(".property_panel") : null);

    const rightWidth = readElementRect(right).width || 200;
    let treeHeight = 0;
    let propHeight = 0;

    if (tree && prop) {
        treeHeight = readElementRect(tree).height;
        propHeight = readElementRect(prop).height;
    }

    const totalDynamicHeight = treeHeight + propHeight;
    let treeFlex = 50;
    let propFlex = 50;
    if (totalDynamicHeight > 0) {
        treeFlex = (treeHeight / totalDynamicHeight) * 100;
        propFlex = (propHeight / totalDynamicHeight) * 100;
    }

    return { rightWidth, treeFlex, propFlex, treeHeight, propHeight, totalDynamicHeight };
}
