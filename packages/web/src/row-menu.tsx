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

/** A clock face for schedules, drawn at the same size and weight. */
export function ClockGlyph() {
  return <svg className="more-glyph line-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.6" /><path d="M8 5v3.2l2.1 1.4" /></svg>;
}

/** The ⌄ chevron for folds and pickers: one size and stroke everywhere, centered by its box. */
export function ChevronGlyph({ className = "" }: { className?: string }) {
  return <svg className={`chevron-glyph ${className}`.trim()} viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3 4.5 6 7.5 9 4.5" /></svg>;
}
