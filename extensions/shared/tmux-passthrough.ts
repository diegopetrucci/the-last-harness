export type TmuxPassthroughEnv = { TMUX?: string | undefined };

/**
 * Wrap one complete terminal escape sequence in tmux DCS passthrough when
 * `env.TMUX` is non-empty; otherwise return it unchanged. Pure; callers opt in
 * per write site and must pass an explicit env.
 */
export function wrapTmuxPassthrough(sequence: string, env: TmuxPassthroughEnv): string {
  if (!env.TMUX) return sequence;
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}
