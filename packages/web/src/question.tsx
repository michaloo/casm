import { useState } from "react";
import { offlineNote } from "./connection";
import type { Answers, QuestionRequest } from "@casm/protocol";

export function Question({
  request,
  answer,
  disabled = false,
}: {
  request: QuestionRequest;
  answer: (answers?: Answers) => void;
  disabled?: boolean;
}) {
  const [values, set] = useState<Answers>({});
  const [other, setOther] = useState<Record<string, string>>({});
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        const answers = { ...values };
        for (const prompt of request.prompts) {
          if (prompt.kind === "select" && prompt.multiple && prompt.allowOther) {
            answers[prompt.id] = [
              ...((values[prompt.id] as string[]) ?? []),
              ...(other[prompt.id] ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
            ];
          }
        }
        answer(answers);
      }}
    >
      <strong>{request.title ?? "Question"}</strong>
      {request.nonBlocking && <p>The agent is still working. Answer before this turn ends.</p>}
      {request.prompts.map((p) => (
        request.nonBlocking && p.kind === "select" ? (
          <fieldset key={p.id}>
            <legend>{p.text}</legend>
            <div className="async-question-options">
              {p.options?.map(o => <button type="button" key={o.label} disabled={disabled}
                aria-pressed={values[p.id] === o.label}
                onClick={() => set({ ...values, [p.id]: o.label })}>{o.label}</button>)}
            </div>
            <label>
              Your answer
              <input required aria-label={`Answer: ${p.text}`} value={String(values[p.id] ?? "")}
                placeholder="Choose an option or type your answer"
                onChange={e => set({ ...values, [p.id]: e.target.value })} />
            </label>
          </fieldset>
        ) : p.kind === "select" && p.multiple ? (
          <fieldset key={p.id}>
            <legend>{p.text}</legend>
            <div className="question-options">
              {p.options?.map((option, index) => {
                const selected = (values[p.id] as string[]) ?? [];
                return <label className="question-option" key={option.label}>
                  <input type="checkbox" checked={selected.includes(option.label)}
                    required={index === 0 && !selected.length && !(p.allowOther && other[p.id]?.trim())}
                    onChange={(e) => set({ ...values, [p.id]: e.target.checked
                      ? [...selected, option.label] : selected.filter((value) => value !== option.label) })} />
                  <span><strong>{option.label}</strong>{option.description && <span className="option-description">{option.description}</span>}</span>
                </label>;
              })}
            </div>
            {p.allowOther &&
            <label>
              Other answers (one per line)
              <textarea
                placeholder={p.placeholder}
                value={other[p.id] ?? ""}
                onChange={(e) => setOther({ ...other, [p.id]: e.target.value })}
              />
            </label>}
          </fieldset>
        ) : <label key={p.id}>
          {p.text}
          {p.kind === "confirm" ? (
            <select
              required
              value={String(values[p.id] ?? "")}
              onChange={(e) =>
                set({ ...values, [p.id]: e.target.value === "true" })
              }
            >
              <option value="">Choose…</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : p.kind === "select" && !p.allowOther ? (
            <select
              required
              multiple={p.multiple}
              value={
                p.multiple
                  ? ((values[p.id] as string[]) ?? [])
                  : ((values[p.id] as string) ?? "")
              }
              onChange={(e) =>
                set({
                  ...values,
                  [p.id]: p.multiple
                    ? Array.from(e.target.selectedOptions, (o) => o.value)
                    : e.target.value,
                })
              }
            >
              {!p.multiple && <option value="">Choose…</option>}
              {p.options?.map((o) => (
                <option key={o.label} value={o.label}>
                  {o.label}
                  {o.description ? ` — ${o.description}` : ""}
                </option>
              ))}
            </select>
          ) : p.kind === "text" && p.multiline && !p.secret ? (
            <textarea
              required
              placeholder={p.placeholder}
              value={String(values[p.id] ?? "")}
              onChange={(e) => set({ ...values, [p.id]: e.target.value })}
            />
          ) : (
            <>
              <input
                required
                type={p.secret ? "password" : "text"}
                placeholder={p.placeholder}
                list={`options-${p.id}`}
                value={String(values[p.id] ?? "")}
                onChange={(e) => set({ ...values, [p.id]: e.target.value })}
              />
              <datalist id={`options-${p.id}`}>
                {p.options?.map((o) => (
                  <option key={o.label}>{o.label}</option>
                ))}
              </datalist>
            </>
          )}
        </label>
      ))}
      <button disabled={disabled} title={disabled ? offlineNote : undefined}>Answer</button>
      <button type="button" disabled={disabled} title={disabled ? offlineNote : undefined} onClick={() => answer()}>
        Dismiss
      </button>
    </form>
  );
}
