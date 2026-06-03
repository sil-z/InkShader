export function logAtomicOperation(actionName, details) {
    console.log(`[Atom Action Test] 🛠️ ${actionName}:`, details);
}

export function generateMarker(type) { 
    return { 
        id: `m_${type}_${Date.now().toString(36)}_${Math.floor(Math.random()*10000)}`, 
        type: type 
    }; 
}