import type { ReactNode } from "react";
import type { Catalog, ProviderId } from "@casm/protocol";
import { ProviderIcon, providerNames } from "./provider-icon";
import { modelLabels } from "./model-label";

const clean = (text: string) => text.replace(/\s*\((?:catalog(?: default)?|recommended)\)/gi, "").trim();
const compactModel = (text: string) => clean(text).replace(/\s*(?:[·–]\s*|\()\d+(?:\.\d+)?[MK](?:\s+context)?\)?$/i, "").trim();
const shortMode = (id: string, name?: string) => ({ default: "Default", auto: "Auto", plan: "Plan", acceptEdits: "Accept edits", bypassPermissions: "Bypass", bypass: "Bypass" }[id] ?? clean(name || id));
const titleCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
type Option = { value: string; label: string; description?: string };

// A native select keeps platform keyboard/touch behavior. Its visible face is
// separate so detailed option text never dictates the collapsed pill's width.
function Picker({ name, value, label, options, onChange, icon, disabled = false, title }: {
  name: string; value: string; label: string; options: Option[]; onChange: (value: string) => void;
  icon?: ReactNode; disabled?: boolean; title?: string;
}) {
  const selected = options.find(option => option.value === value);
  return <label className={`composer-picker${disabled ? " composer-picker-fixed" : ""}`} title={title ?? selected?.description ?? label}>
    {icon}<span className="composer-picker-label" aria-hidden={!disabled}>{label}</span>
    {!disabled && <span className="composer-picker-chevron" aria-hidden="true">⌄</span>}
    {!disabled && <select aria-label={name} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}{option.description ? ` — ${option.description}` : ""}</option>)}
    </select>}
  </label>;
}

export function ComposerPickers({ provider, fixedProvider, catalog, model, effectiveModel, mode, effort, setProvider, setModel, setMode, setEffort }: {
  provider: ProviderId; fixedProvider: boolean; catalog: Catalog; model: string; effectiveModel?: string | null;
  mode: string; effort: string; setProvider: (value: ProviderId) => void; setModel: (value: string) => void;
  setMode: (value: string) => void; setEffort: (value: string) => void;
}) {
  const labels = modelLabels(model, effectiveModel, catalog.models);
  const defaultLabel = effectiveModel && !/^default\b/i.test(compactModel(labels.actual ?? "")) ? `Default · ${compactModel(labels.actual!)}` : "Default";
  const selectedModel = catalog.models.find(item => item.id === (model || effectiveModel)) ?? (!model ? catalog.models.find(item => item.isDefault) : undefined);
  const modelOptions: Option[] = [{ value: "", label: defaultLabel, description: effectiveModel ? labels.sessionTitle : "Use the provider's default model" },
    ...catalog.models.map(item => ({ value: item.id, label: clean(item.name || item.id), description: item.description }))];
  if (model && !catalog.models.some(item => item.id === model)) modelOptions.push({ value: model, label: model });
  const modes: Option[] = [{ value: "", label: "Default", description: "Use the provider's default mode" }, ...catalog.modes.map(item => ({ value: item.id, label: shortMode(item.id, item.name), description: [item.name, item.description].filter(Boolean).join(" — ") }))];
  if (mode && !catalog.modes.some(item => item.id === mode)) modes.push({ value: mode, label: shortMode(mode) });
  const efforts = selectedModel?.efforts ?? [];
  return <div className="pickers">
    <Picker name="Provider" value={provider} label={provider === "pi" ? "pi" : providerNames[provider]} icon={<ProviderIcon provider={provider} />} disabled={fixedProvider}
      options={(["claude", "codex", "opencode", "pi"] as ProviderId[]).map(id => ({ value: id, label: id === "pi" ? "pi" : providerNames[id] }))} onChange={value => setProvider(value as ProviderId)} />
    <Picker name="Model" value={model} label={model ? compactModel(labels.selectedLabel) : defaultLabel} options={modelOptions} onChange={setModel}
      title={[model || "Provider default", selectedModel?.name, selectedModel?.description, labels.sessionTitle].filter(Boolean).join(" · ")} />
    {catalog.modes.length > 1 && <Picker name="Mode" value={mode} label={modes.find(item => item.value === mode)?.label ?? "Default"} options={modes} onChange={setMode} />}
    {efforts.length > 1 && <Picker name="Effort" value={effort} label={effort ? titleCase(effort) : "Default"} options={[{ value: "", label: "Default", description: "Use the model's default reasoning effort" }, ...efforts.map(value => ({ value, label: titleCase(value) }))]} onChange={setEffort} />}
    {labels.showSession && <small className="model-session" title={labels.sessionTitle}>Session: {compactModel(labels.actual!)}</small>}
  </div>;
}
