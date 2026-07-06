export function installEnterBlurHandler(container) {
    container.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const target = event.target;
        if (!target || target.tagName !== 'INPUT') return;
        event.preventDefault();
        target.blur();
    });
}

export function readInputValue(input) {
    if (!input) return '';
    if (input.type === 'checkbox') return input.checked ? 'true' : 'false';
    return input.value;
}

export function rememberInputValue(host, input) {
    if (!host || !input) return;
    if (!host._rememberedInputValues) host._rememberedInputValues = new WeakMap();
    host._rememberedInputValues.set(input, readInputValue(input));
}

export function rememberedInputValue(host, input) {
    return host?._rememberedInputValues?.get(input);
}

export function forgetInputValue(host, input) {
    host?._rememberedInputValues?.delete(input);
}

export function restoreRememberedInputValue(host, input, fallback = '') {
    if (!input) return fallback;
    const value = rememberedInputValue(host, input);
    const nextValue = value !== undefined ? value : fallback;
    if (input.type === 'checkbox') {
        input.checked = nextValue === true || nextValue === 'true';
    } else {
        input.value = nextValue;
    }
    return nextValue;
}

export function trimmedInputValue(input) {
    return input?.value?.trim?.() ?? '';
}

export function isValidTreeName(value) {
    return typeof value === 'string' && value.trim().length > 0 && !value.includes('\\');
}

export function numberFromInput(input) {
    if (!input || input.value === '') return NaN;
    return input.type === 'number' ? input.valueAsNumber : Number(input.value);
}

export function isValidNumber(value, { min = -Infinity, max = Infinity } = {}) {
    return Number.isFinite(value) && value >= min && value <= max;
}

export function isValidNumberInput(input, options = {}) {
    return isValidNumber(numberFromInput(input), options);
}
