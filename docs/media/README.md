# Recording the README demos

    ./docs/media/record.sh            # record and render everything
    ./docs/media/record.sh continue   # just one scene
    RENDER_ONLY=1 ./docs/media/record.sh   # re-render existing casts

Needs `asciinema`, `agg` and `expect` (`brew install asciinema agg expect`).

Recording and rendering are separate steps. A cast is expensive to make and
cheap to re-render, so changing the theme, the font or the trim never means
driving the terminal again - that is what `RENDER_ONLY=1` is for.

## The pieces

| file | what it does |
|---|---|
| `record.sh` | scene list, look, the render call |
| `drive.exp` | types into the recording; sits **outside** asciinema, because a cast recorded inside expect's own pty comes out blank |
| `*.steps` | one scene each, in a small `type` / `enter` / `wait` line format |
| `seed.sh` | resets the demo HOME before every take |
| `demo.bashrc` | the neutral prompt and environment on screen |
| `casts/` | the recordings, kept so the GIFs can be re-rendered |

## The demo HOME

Everything runs against `~/casm-demo/home`, a throwaway HOME holding synthetic
sessions in two invented projects, so no real work is ever on screen.
`~/casm-demo/pristine` is the canonical copy; `seed.sh` restores from it before
each take and then:

- **re-dates every session relative to now.** Absolute timestamps would age, and
  a demo recorded today would say "2.3d ago" next month. The offsets are chosen
  to look like a real week of work.
- **seeds a claude credential**, access token only, via casm's own
  `claudeCredential()`. Without one the agent renders a red "Not logged in"
  across the frame. Stripping the refresh token is the point: this throwaway
  HOME must not be able to rotate the token out from under your real login.

Both halves matter because a demo *runs* the agents for real, and an agent that
resumes a session rewrites its transcript and bumps its mtime - which reorders
the picker, so a scene that types `3` would select something different on the
next take.

## Gotchas

- `--idle-time-limit` is applied by agg **before** everything else, `--select`
  included. Set it below a scene's reading pause and the exact frames the demo
  exists to show get silently compressed. Keep it above the longest `wait`.
- A cast ends at its last *event*, so a scene finishing on a silent pause is
  shorter than wall clock. The trim mark is clamped for this.
- Never end a scene by typing a bare word and pressing return. If an agent is
  still in the foreground that is a prompt submitted to the model, not a shell
  command. `drive.exp` interrupts first, then exits.
