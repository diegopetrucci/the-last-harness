// Generated from extensions/shared/tmux-passthrough.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
export function wrapTmuxPassthrough(sequence, env) {
    if (!env.TMUX)
        return sequence;
    return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}
