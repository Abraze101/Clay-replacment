import type { ReactElement } from "react";

import type { CapabilityOverrides, Profile } from "../api/types.js";
import type { NewRunFlow } from "../state/newRunFlow.js";

const PRESETS: { value: Profile; title: string; blurb: string }[] = [
  {
    value: "quick_list",
    title: "Quick List",
    blurb: "Discover and clean up businesses — no paid person/contact enrichment.",
  },
  {
    value: "call_ready",
    title: "Call-Ready",
    blurb: "Quick List plus contact discovery and validation for calling (paid steps preview first).",
  },
  {
    value: "full",
    title: "Full Enrichment",
    blurb: "Call-Ready plus research, scoring, and personalized openers.",
  },
];

type ToggleKey = Exclude<keyof CapabilityOverrides, "findOwner">;

const TOGGLES: { key: ToggleKey; label: string; m5: boolean }[] = [
  { key: "findPhones", label: "Find additional phone numbers", m5: true },
  { key: "validatePhones", label: "Validate phone numbers (line status)", m5: true },
  { key: "requireDirectPhone", label: "Require a direct/mobile number", m5: true },
  { key: "acceptBusinessMainPhone", label: "A business main line is fine", m5: true },
  { key: "findEmail", label: "Find a work email", m5: true },
  { key: "validateEmail", label: "Validate the email", m5: true },
  { key: "acceptCatchAllEmail", label: "Accept catch-all/unknown email results", m5: true },
  { key: "skipPersonalization", label: "Skip personalization", m5: false },
];

/** Step 2: preset + capability toggles; compiles into the same typed run options the engine previews. */
export function PresetScreen({
  flow,
  onBack,
  onPreview,
  previewing,
  error,
}: {
  flow: NewRunFlow;
  onBack: () => void;
  onPreview: () => void;
  previewing: boolean;
  error: string | null;
}): ReactElement {
  const { fields } = flow;
  return (
    <div>
      <section className="card">
        <h2>2 · Choose enrichment depth</h2>
        <div className="preset-grid">
          {PRESETS.map((preset) => (
            <label key={preset.value} className={`preset ${fields.profile === preset.value ? "preset-active" : ""}`}>
              <input
                type="radio"
                name="profile"
                checked={fields.profile === preset.value}
                onChange={() => flow.update({ profile: preset.value })}
              />
              <strong>{preset.title}</strong>
              <span className="muted">{preset.blurb}</span>
            </label>
          ))}
        </div>

        <h3>Capabilities</h3>
        <label className="toggle">
          <input type="checkbox" checked={fields.findOwner} onChange={(e) => flow.update({ findOwner: e.target.checked })} />
          <span>Find the owner / decision-maker</span>
          <span className="muted">(unchecking skips the paid owner-enrichment step)</span>
        </label>
        {TOGGLES.map((toggle) => (
          <label key={toggle.key} className="toggle">
            <input
              type="checkbox"
              checked={fields.overrides[toggle.key] === true}
              onChange={(e) =>
                flow.update({
                  overrides: e.target.checked
                    ? { ...fields.overrides, [toggle.key]: true }
                    : removeKey(fields.overrides, toggle.key),
                })
              }
            />
            <span>{toggle.label}</span>
            {toggle.m5 && <span className="chip chip-muted">recorded in your approval — active from Milestone 5</span>}
          </label>
        ))}

        <h3>Limits</h3>
        <label className="field">
          <span>Paid record cap (max 100)</span>
          <input
            type="number"
            min={0}
            max={100}
            value={fields.cap}
            placeholder="engine default"
            onChange={(e) => flow.update({ cap: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Credit budget</span>
          <input
            type="number"
            min={0}
            value={fields.budget}
            placeholder="estimated cost"
            onChange={(e) => flow.update({ budget: e.target.value })}
          />
        </label>

        {error && <p className="error-banner">{error}</p>}
        <div className="row row-between">
          <button className="btn" onClick={onBack}>
            Back
          </button>
          <button className="btn btn-primary" disabled={previewing} onClick={onPreview}>
            {previewing ? "Resolving plan…" : "Preview cost & plan"}
          </button>
        </div>
        <p className="muted">Nothing runs and nothing is spent until you approve the preview on the next step.</p>
      </section>
    </div>
  );
}

function removeKey(overrides: NewRunFlow["fields"]["overrides"], key: ToggleKey): NewRunFlow["fields"]["overrides"] {
  const next = { ...overrides };
  delete next[key];
  return next;
}
