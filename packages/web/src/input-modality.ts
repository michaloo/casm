// Marks <html data-input> with the last way the user interacted, so focus
// rings can follow the keyboard only (see the end of style.css).
const mark = (input: "pointer" | "keyboard") => () => { document.documentElement.dataset.input = input; };
addEventListener("pointerdown", mark("pointer"), { capture: true, passive: true });
addEventListener("keydown", mark("keyboard"), { capture: true, passive: true });
