# Shell for the README recordings. Nothing here is casm's runtime config - it
# exists so the demos show a neutral prompt and a fixed environment rather than
# whatever the machine doing the recording happens to have.
PS1='\[\033[38;5;110m\]❯\[\033[0m\] '
PS2='  '
export BASH_SILENCE_DEPRECATION_WARNING=1

# The demos run against ~/casm-demo/home, a throwaway HOME holding synthetic
# sessions, so nothing real shows up on screen. HOME is exported by record.sh.
export PATH="$CASM_REPO/bin:$PATH"
export TERM=xterm-256color

# The recording machine is usually mid-session in Claude Code, and those
# variables would leak into the demo (an inherited session id, a proxy, a model
# override changing what the agent prints).
for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_]*' ); do unset "$v"; done

unset HISTFILE
shopt -u histappend 2>/dev/null
alias casm="node $CASM_REPO/bin/casm.mjs"
clear
