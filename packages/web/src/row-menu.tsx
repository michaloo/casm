/** The ⋯ glyph shared by every sidebar row with options. */
export function MoreGlyph() {
  return <svg className="more-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="3.5" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="12.5" cy="8" r="1.4" />
  </svg>;
}

/** The + glyph, drawn at the same size and weight. */
export function PlusGlyph() {
  return <svg className="more-glyph plus-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3.5v9M3.5 8h9" /></svg>;
}

/** The ⌄ chevron for folds and pickers: one size and stroke everywhere, centered by its box. */
export function ChevronGlyph({ className = "" }: { className?: string }) {
  return <svg className={`chevron-glyph ${className}`.trim()} viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3 4.5 6 7.5 9 4.5" /></svg>;
}

/** A paperclip for attaching images. */
export function AttachGlyph() {
  return <svg className="attach-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M13.2 7.6 8.1 12.7a3.3 3.3 0 0 1-4.7-4.7l5.3-5.3a2.2 2.2 0 0 1 3.1 3.1L6.6 11a1.1 1.1 0 0 1-1.6-1.6l4.8-4.8" /></svg>;
}
