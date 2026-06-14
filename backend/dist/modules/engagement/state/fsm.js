"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextState = nextState;
exports.isTerminal = isTerminal;
exports.isValidState = isValidState;
exports.allowedEvents = allowedEvents;
function nextState(def, from, event) {
    const node = def.states[from];
    if (!node || node.terminal)
        return null;
    return node.on[event] ?? null;
}
function isTerminal(def, state) {
    return !!def.states[state]?.terminal;
}
function isValidState(def, state) {
    return Object.prototype.hasOwnProperty.call(def.states, state);
}
function allowedEvents(def, from) {
    const node = def.states[from];
    if (!node || node.terminal)
        return [];
    return Object.keys(node.on);
}
//# sourceMappingURL=fsm.js.map