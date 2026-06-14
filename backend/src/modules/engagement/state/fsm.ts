/**
 * Minimal, dependency-free finite-state-machine definition + evaluator. The
 * engagement engine's determinism lives here: every work-item / order / ticket
 * state change must be an explicit, declared transition — there are no free-form
 * status writes. A transition that isn't in the table simply does not happen.
 */

export interface StateNode<S extends string> {
  /** Terminal states accept no further transitions. */
  terminal?: boolean;
  /** event name → next state. */
  on: Partial<Record<string, S>>;
}

export interface FsmDef<S extends string> {
  initial: S;
  states: Record<S, StateNode<S>>;
}

/**
 * Returns the next state for (from, event), or null if the transition is not
 * declared (or `from` is terminal). Callers treat null as "rejected".
 */
export function nextState<S extends string>(
  def: FsmDef<S>,
  from: S,
  event: string,
): S | null {
  const node = def.states[from];
  if (!node || node.terminal) return null;
  return (node.on[event] as S | undefined) ?? null;
}

export function isTerminal<S extends string>(def: FsmDef<S>, state: S): boolean {
  return !!def.states[state]?.terminal;
}

export function isValidState<S extends string>(
  def: FsmDef<S>,
  state: string,
): state is S {
  return Object.prototype.hasOwnProperty.call(def.states, state);
}

/** All event names that are valid from `from` (for tool-gating / introspection). */
export function allowedEvents<S extends string>(
  def: FsmDef<S>,
  from: S,
): string[] {
  const node = def.states[from];
  if (!node || node.terminal) return [];
  return Object.keys(node.on);
}
