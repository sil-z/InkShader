/**
 * InkShader Custom Cursor
 */
(function () {
    if (typeof window === 'undefined') return;
    
    if (window.InkShaderCursor) return;

    const PRESETS = {
        default: { outerSize: 32, hoverOuterSize: 52, innerSize: 6 },
        large:     { outerSize: 128, hoverOuterSize: 205, innerSize: 6 },
    };

    const defaultOpts = {
        outerSize: 32,
        hoverOuterSize: 52,
        innerSize: 6,
        springStiffness: 400,
        springDamping: 45,
        springMass: 0.5,
        mobileMinWidth: 768,
        activeClasses: ['inkshader-cursor-active', 'custom-cursor-active'],
        syncOuter: false,
    };

    let opts = { ...defaultOpts };
    let isInitialized = false;

    let container = null;
    let outerPos = null;
    let outerVisual = null;
    let innerPos = null;
    let innerVisual = null;

    let clientX = -100;
    let clientY = -100;
    let targetX = -100;
    let targetY = -100;
    let currentX = -100;
    let currentY = -100;

    let vx = 0;
    let vy = 0;
    let lastTime = 0;

    let isVisible = false;
    let isInsideWindow = false;
    let hasMoved = false;
    let lastTrackedCursor = '';

    let animationFrameId = null;
    let springSolver = null;

    const ALL_STATES = [
        'is-hovered', 
        'is-text', 
        'is-resize-horizontal', 
        'is-resize-vertical', 
        'is-resize-diagonal-1', 
        'is-resize-diagonal-2', 
        'is-crosshair', 
        'is-move', 
        'is-not-allowed', 
        'is-loading'
    ];

    function init(config) {
        if (isInitialized) destroy();

        opts = { ...defaultOpts };

        if (config) {
            if (config.preset && PRESETS[config.preset]) {
                opts = { ...opts, ...PRESETS[config.preset] };
            }
            opts = { ...opts, ...config };
        }

        createElements();
        injectStyles();
        bindEvents();
        checkEnvironment();
        createSpringSolver();

        lastTime = performance.now();
        animationFrameId = requestAnimationFrame(updateFrame);
        isInitialized = true;
    }

    function createSpringSolver() {
        const stiffness = opts.springStiffness;
        const damping = opts.springDamping;
        const mass = opts.springMass;

        const w0 = Math.sqrt(stiffness / mass);
        const zeta = damping / (2 * Math.sqrt(stiffness * mass));

        if (zeta < 1) {
            const wd = w0 * Math.sqrt(1 - zeta * zeta);
            springSolver = function (t, x0, v0) {
                const envelope = Math.exp(-zeta * w0 * t);
                const cosTerm = Math.cos(wd * t);
                const sinTerm = Math.sin(wd * t);
                const x = envelope * (x0 * cosTerm + ((zeta * w0 * x0 + v0) / wd) * sinTerm);
                const v = -zeta * w0 * x + envelope * (-wd * x0 * sinTerm + (zeta * w0 * x0 + v0) * cosTerm);
                return [x, v];
            };
        } else if (Math.abs(zeta - 1) < 1e-6) {
            springSolver = function (t, x0, v0) {
                const envelope = Math.exp(-w0 * t);
                const x = envelope * (x0 + (v0 + w0 * x0) * t);
                const v = envelope * (v0 * (1 - w0 * t) - w0 * w0 * x0 * t);
                return [x, v];
            };
        } else {
            const s1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
            const s2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
            springSolver = function (t, x0, v0) {
                const c1 = (v0 - s2 * x0) / (s1 - s2);
                const c2 = x0 - c1;
                const x = c1 * Math.exp(s1 * t) + c2 * Math.exp(s2 * t);
                const v = c1 * s1 * Math.exp(s1 * t) + c2 * s2 * Math.exp(s2 * t);
                return [x, v];
            };
        }
    }

    function createElements() {
        container = document.createElement('div');
        container.id = 'inkshader-cursor-container';
        container.className = 'inkshader-cursor-container';

        outerPos = document.createElement('div');
        outerPos.className = 'inkshader-cursor-outer-pos';
        outerVisual = document.createElement('div');
        outerVisual.className = 'inkshader-cursor-outer-visual';
        outerPos.appendChild(outerVisual);

        innerPos = document.createElement('div');
        innerPos.className = 'inkshader-cursor-inner-pos';
        innerVisual = document.createElement('div');
        innerVisual.className = 'inkshader-cursor-inner-visual';
        innerPos.appendChild(innerVisual);

        container.appendChild(outerPos);
        container.appendChild(innerPos);
        document.body.appendChild(container);
    }

    function injectStyles() {
        let styleEl = document.getElementById('inkshader-cursor-styles');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'inkshader-cursor-styles';
            document.head.appendChild(styleEl);
        }

        styleEl.innerHTML = `
            .inkshader-cursor-container {
                pointer-events: none;
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                z-index: 999999;
                opacity: 0;
                transition: opacity 0.35s ease;
                mix-blend-mode: difference;
            }
            .inkshader-cursor-container.is-visible { opacity: 1; }
            
            .inkshader-cursor-outer-pos, .inkshader-cursor-inner-pos {
                position: fixed;
                top: 0;
                left: 0;
                pointer-events: none;
                will-change: transform;
            }
            
            .inkshader-cursor-outer-visual {
                width: ${opts.outerSize}px;
                height: ${opts.outerSize}px;
                border-radius: 50%;
                border: 1px solid rgba(255, 255, 255, 0.45);
                background-color: transparent;
                transform: translate(-50%, -50%);
                transition: width 0.25s cubic-bezier(0.16, 1, 0.3, 1), 
                                        height 0.25s cubic-bezier(0.16, 1, 0.3, 1), 
                                        border-color 0.25s ease, background-color 0.25s ease;
                box-sizing: border-box;
            }
            
            .inkshader-cursor-inner-visual {
                position: relative;
                width: ${opts.innerSize}px;
                height: ${opts.innerSize}px;
                border-radius: 50%;
                background-color: #ffffff;
                transform: translate(-50%, -50%) scale(1);
                transition: transform 0.15s cubic-bezier(0.16, 1, 0.3, 1),
                                        width 0.18s cubic-bezier(0.16, 1, 0.3, 1),
                                        height 0.18s cubic-bezier(0.16, 1, 0.3, 1),
                                        border-radius 0.18s ease, background-color 0.15s ease,
                                        border-color 0.15s ease, opacity 0.15s ease;
                box-sizing: border-box;
            }

            .inkshader-cursor-inner-visual::before, .inkshader-cursor-inner-visual::after {
                content: "";
                position: absolute;
                opacity: 0;
                transition: opacity 0.12s ease;
                pointer-events: none;
                box-sizing: border-box;
            }
            
            .inkshader-cursor-container.is-hovered .inkshader-cursor-outer-visual {
                width: ${opts.hoverOuterSize}px;
                height: ${opts.hoverOuterSize}px;
                border-color: rgba(255, 255, 255, 0.65);
            }
            .inkshader-cursor-container.is-hovered .inkshader-cursor-inner-visual {
                transform: translate(-50%, -50%) scale(0.4);
            }
            
            .inkshader-cursor-container.is-text .inkshader-cursor-inner-visual {
                width: 1px;
                height: 18px;
                border-radius: 0px;
                transform: translate(-50%, -50%);
            }

            .inkshader-cursor-container.is-resize-horizontal .inkshader-cursor-inner-visual {
                width: 14px;
                height: 1.5px;
                border-radius: 0px;
            }
            .inkshader-cursor-container.is-resize-horizontal .inkshader-cursor-inner-visual::before {
                opacity: 1; left: -4px; top: -3.25px;
                border-right: 5px solid #ffffff; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
            }
            .inkshader-cursor-container.is-resize-horizontal .inkshader-cursor-inner-visual::after {
                opacity: 1; right: -4px; top: -3.25px;
                border-left: 5px solid #ffffff; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
            }

            .inkshader-cursor-container.is-resize-vertical .inkshader-cursor-inner-visual {
                width: 1.5px;
                height: 14px;
                border-radius: 0px;
            }
            .inkshader-cursor-container.is-resize-vertical .inkshader-cursor-inner-visual::before {
                opacity: 1; top: -4px; left: -3.25px;
                border-bottom: 5px solid #ffffff; border-left: 4px solid transparent; border-right: 4px solid transparent;
            }
            .inkshader-cursor-container.is-resize-vertical .inkshader-cursor-inner-visual::after {
                opacity: 1; bottom: -4px; left: -3.25px;
                border-top: 5px solid #ffffff; border-left: 4px solid transparent; border-right: 4px solid transparent;
            }

            .inkshader-cursor-container.is-resize-diagonal-1 .inkshader-cursor-inner-visual {
                width: 14px; height: 1.5px; border-radius: 0px;
                transform: translate(-50%, -50%) rotate(45deg);
            }
            .inkshader-cursor-container.is-resize-diagonal-1 .inkshader-cursor-inner-visual::before {
                opacity: 1; left: -4px; top: -3.25px;
                border-right: 5px solid #ffffff; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
            }
            .inkshader-cursor-container.is-resize-diagonal-1 .inkshader-cursor-inner-visual::after {
                opacity: 1; right: -4px; top: -3.25px;
                border-left: 5px solid #ffffff; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
            }

            .inkshader-cursor-container.is-resize-diagonal-2 .inkshader-cursor-inner-visual {
                width: 14px; height: 1.5px; border-radius: 0px;
                transform: translate(-50%, -50%) rotate(-45deg);
            }
            .inkshader-cursor-container.is-resize-diagonal-2 .inkshader-cursor-inner-visual::before {
                opacity: 1; left: -4px; top: -3.25px;
                border-right: 5px solid #ffffff; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
            }
            .inkshader-cursor-container.is-resize-diagonal-2 .inkshader-cursor-inner-visual::after {
                opacity: 1; right: -4px; top: -3.25px;
                border-left: 5px solid #ffffff; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
            }

            .inkshader-cursor-container.is-crosshair .inkshader-cursor-inner-visual {
                width: 16px; height: 16px; background-color: transparent; border-radius: 0px;
            }
            .inkshader-cursor-container.is-crosshair .inkshader-cursor-inner-visual::before {
                opacity: 1; width: 16px; height: 1px; background-color: #ffffff; top: 7.5px; left: 0;
            }
            .inkshader-cursor-container.is-crosshair .inkshader-cursor-inner-visual::after {
                opacity: 1; width: 1px; height: 16px; background-color: #ffffff; top: 0; left: 7.5px;
            }

            .inkshader-cursor-container.is-move .inkshader-cursor-inner-visual {
                width: 4px; height: 4px; background-color: #ffffff; border-radius: 50%;
            }
            .inkshader-cursor-container.is-move .inkshader-cursor-inner-visual::before {
                opacity: 1; width: 14px; height: 1px; background-color: #ffffff; top: 1.5px; left: -5px;
            }
            .inkshader-cursor-container.is-move .inkshader-cursor-inner-visual::after {
                opacity: 1; width: 1px; height: 14px; background-color: #ffffff; top: -5px; left: 1.5px;
            }

            .inkshader-cursor-container.is-not-allowed .inkshader-cursor-inner-visual {
                width: 16px; height: 1.5px; background-color: #ffffff; border-radius: 0px;
                transform: translate(-50%, -50%) rotate(-45deg);
            }

            .inkshader-cursor-container.is-loading .inkshader-cursor-outer-visual {
                border-color: rgba(255, 255, 255, 0.15);
                border-top-color: #ffffff;
                animation: inkshader-spin 0.75s linear infinite;
            }
            .inkshader-cursor-container.is-loading .inkshader-cursor-inner-visual {
                transform: translate(-50%, -50%) scale(0.4);
                opacity: 0.4;
            }

            @keyframes inkshader-spin {
                from { transform: translate(-50%, -50%) rotate(0deg); }
                to { transform: translate(-50%, -50%) rotate(360deg); }
            }
        `;

        let hideStyleEl = document.getElementById('inkshader-cursor-hide-styles');
        if (!hideStyleEl) {
            hideStyleEl = document.createElement('style');
            hideStyleEl.id = 'inkshader-cursor-hide-styles';
            document.head.appendChild(hideStyleEl);
        }
        
        hideStyleEl.innerHTML = opts.activeClasses.map(cls => `
            html.${cls}, html.${cls} * { cursor: none !important; }
        `).join('\n');
    }

    function bindEvents() {
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseover', onMouseOver);
        window.addEventListener('resize', onResize);
        document.addEventListener('mouseleave', onMouseLeave);
        document.addEventListener('mouseenter', onMouseEnter);
    }

    function onMouseMove(e) {
        if (!isVisible) return;
        
        clientX = e.clientX;
        clientY = e.clientY;
        targetX = clientX;
        targetY = clientY;

        const hideStyleEl = document.getElementById('inkshader-cursor-hide-styles');

        const target = e.target;
        if (target) {
            if (hideStyleEl) hideStyleEl.disabled = true;
            const currentCursor = window.getComputedStyle(target).cursor;
            if (hideStyleEl) hideStyleEl.disabled = false;

            if (currentCursor && currentCursor !== lastTrackedCursor) {
                lastTrackedCursor = currentCursor;
                evaluateNativeCursor(target, currentCursor);
            }
        }

        if (!hasMoved) {
            currentX = targetX;
            currentY = targetY;
            hasMoved = true;
        }

        if (!isInsideWindow) {
            isInsideWindow = true;
            updateContainerVisibility();
        }

        if (!container.classList.contains('is-visible') && isInsideWindow) {
            container.classList.add('is-visible');
        }
    }

    function evaluateNativeCursor(target, nativeCursor) {
        if (!target || !container) return;

        if (!nativeCursor) {
            const hideStyleEl = document.getElementById('inkshader-cursor-hide-styles');
            if (hideStyleEl) hideStyleEl.disabled = true;
            nativeCursor = window.getComputedStyle(target).cursor;
            if (hideStyleEl) hideStyleEl.disabled = false;
        }

        const isTextFallback = (target.tagName === 'INPUT' && target.type !== 'checkbox' && target.type !== 'radio') || target.tagName === 'TEXTAREA' || target.isContentEditable;
        const isClickable =
            target.tagName === 'A' ||
            target.tagName === 'BUTTON' ||
            target.closest('button') ||
            target.closest('a') ||
            target.closest('[data-hover-expand="true"]') ||
            target.classList.contains('cursor-pointer') ||
            nativeCursor === 'pointer';

        ALL_STATES.forEach(cls => container.classList.remove(cls));

        if (nativeCursor === 'wait' || nativeCursor === 'progress') {
            container.classList.add('is-loading');
        } else if (nativeCursor === 'not-allowed') {
            container.classList.add('is-not-allowed');
        } else if (nativeCursor === 'text' || nativeCursor === 'vertical-text' || isTextFallback) {
            container.classList.add('is-text');
        } else if (['ew-resize', 'col-resize', 'e-resize', 'w-resize'].includes(nativeCursor)) {
            container.classList.add('is-resize-horizontal');
        } else if (['ns-resize', 'row-resize', 'n-resize', 's-resize'].includes(nativeCursor)) {
            container.classList.add('is-resize-vertical');
        } else if (['nwse-resize', 'nw-resize', 'se-resize'].includes(nativeCursor)) {
            container.classList.add('is-resize-diagonal-1');
        } else if (['nesw-resize', 'ne-resize', 'sw-resize'].includes(nativeCursor)) {
            container.classList.add('is-resize-diagonal-2');
        } else if (nativeCursor === 'crosshair') {
            container.classList.add('is-crosshair');
        } else if (nativeCursor === 'move') {
            container.classList.add('is-move');
        } else if (isClickable) {
            container.classList.add('is-hovered');
        }
    }

    function onMouseOver(e) {
        const target = e.target;
        if (!target || !container) return;

        const hideStyleEl = document.getElementById('inkshader-cursor-hide-styles');
        if (hideStyleEl) hideStyleEl.disabled = true;
        lastTrackedCursor = window.getComputedStyle(target).cursor;
        if (hideStyleEl) hideStyleEl.disabled = false;

        evaluateNativeCursor(target);
    }

    function onResize() {
        checkEnvironment();
    }

    function onMouseLeave() {
        isInsideWindow = false;
        updateContainerVisibility();
    }

    function onMouseEnter() {
        isInsideWindow = true;
        updateContainerVisibility();
    }

    function checkEnvironment() {
        const isTouchOnly = window.matchMedia('(pointer: coarse)').matches;
        const isMobileWidth = window.innerWidth <= opts.mobileMinWidth;
        const shouldBeActive = !isTouchOnly && !isMobileWidth;

        if (shouldBeActive) {
            isVisible = true;
            opts.activeClasses.forEach(cls => {
                document.documentElement.classList.add(cls);
            });
        } else {
            isVisible = false;
            opts.activeClasses.forEach(cls => {
                document.documentElement.classList.remove(cls);
            });
            hasMoved = false;
        }

        updateContainerVisibility();
    }

    function updateContainerVisibility() {
        if (!container) return;
        if (isVisible && isInsideWindow && hasMoved) {
            container.classList.add('is-visible');
        } else {
            container.classList.remove('is-visible');
        }
    }

    function updateFrame() {
        const now = performance.now();
        let dt = (now - lastTime) / 1000;
        lastTime = now;

        if (dt > 0.1) dt = 0.1;
        if (dt <= 0) dt = 0.001;

        if (isVisible && hasMoved) {
            if (innerPos) {
                innerPos.style.transform = `translate3d(${clientX}px, ${clientY}px, 0)`;
            }

            if (opts.syncOuter) {
                currentX = targetX;
                currentY = targetY;
            } else if (springSolver) {
                const x0 = currentX - targetX;
                const [nextXDisplacement, nextVx] = springSolver(dt, x0, vx);
                currentX = targetX + nextXDisplacement;
                vx = nextVx;

                const y0 = currentY - targetY;
                const [nextYDisplacement, nextVy] = springSolver(dt, y0, vy);
                currentY = targetY + nextYDisplacement;
                vy = nextVy;
            }

            if (outerPos) {
                outerPos.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
            }
        }

        animationFrameId = requestAnimationFrame(updateFrame);
    }

    function destroy() {
        if (!isInitialized) return;

        if (animationFrameId) cancelAnimationFrame(animationFrameId);

        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseover', onMouseOver);
        window.removeEventListener('resize', onResize);
        document.removeEventListener('mouseleave', onMouseLeave);
        document.removeEventListener('mouseenter', onMouseEnter);

        opts.activeClasses.forEach(cls => {
            document.documentElement.classList.remove(cls);
        });

        if (container && container.parentNode) container.parentNode.removeChild(container);
        
        let styleEl = document.getElementById('inkshader-cursor-styles');
        if (styleEl) styleEl.parentNode.removeChild(styleEl);
        
        let hideStyleEl = document.getElementById('inkshader-cursor-hide-styles');
        if (hideStyleEl) hideStyleEl.parentNode.removeChild(hideStyleEl);

        container = null; outerPos = null; outerVisual = null;
        innerPos = null; innerVisual = null;
        isInitialized = false; hasMoved = false;
    }

    function disable() {
        if (!isInitialized) return;
        isVisible = false;
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        opts.activeClasses.forEach(cls => {
            document.documentElement.classList.remove(cls);
        });
        if (container) container.classList.remove('is-visible');
        const hideStyleEl = document.getElementById('inkshader-cursor-hide-styles');
        if (hideStyleEl) hideStyleEl.disabled = true;
    }

    function enable() {
        if (!isInitialized) {
            init({ preset: 'default', syncOuter: false });
            return;
        }
        checkEnvironment();
        if (!animationFrameId) {
            lastTime = performance.now();
            animationFrameId = requestAnimationFrame(updateFrame);
        }
    }

    window.InkShaderCursor = { init, destroy, disable, enable, version: '1.4.0' };

    function autoInit() {
        if (window.INKSHADER_CURSOR_DISABLED) return;
        if (document.body) { 
            if (!isInitialized) init({ preset: 'default', syncOuter: false }); 
        } else { 
            document.addEventListener('DOMContentLoaded', () => {
                if (window.INKSHADER_CURSOR_DISABLED) return;
                if (!isInitialized) init({ preset: 'default', syncOuter: false }); 
            }); 
        }
    }
    autoInit();
})();