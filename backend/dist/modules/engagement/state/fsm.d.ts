export interface StateNode<S extends string> {
    terminal?: boolean;
    on: Partial<Record<string, S>>;
}
export interface FsmDef<S extends string> {
    initial: S;
    states: Record<S, StateNode<S>>;
}
export declare function nextState<S extends string>(def: FsmDef<S>, from: S, event: string): S | null;
export declare function isTerminal<S extends string>(def: FsmDef<S>, state: S): boolean;
export declare function isValidState<S extends string>(def: FsmDef<S>, state: string): state is S;
export declare function allowedEvents<S extends string>(def: FsmDef<S>, from: S): string[];
