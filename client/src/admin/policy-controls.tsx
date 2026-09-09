import { useEffect, useMemo, useState } from "react";
import { countryName, flagOf, searchCountries } from "../lib/countries";

/**
 * Controls shared by the Return policies tabs: a switch, a number field
 * that stays text while typed, and the country picker.
 */

export function Switch({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch${on ? " is-on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="switch__knob" />
    </button>
  );
}

/**
 * A number that stays text while it's typed.
 *
 * Bound straight to a number, clearing the field to type a new value would
 * snap it back to something and eat the keystrokes. The parent only hears
 * about values that parse and clear the floor; on blur the field settles
 * back to whatever the parent holds.
 */
export function NumberField({
  value,
  min,
  max,
  step,
  unit,
  unitFirst = false,
  wide = false,
  onChange,
}: {
  value: number;
  min: number;
  max?: number;
  step?: string;
  unit: string;
  unitFirst?: boolean;
  wide?: boolean;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // Only when the parent's value moves, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const unitEl = (
    <span className={`unit-field__unit${unitFirst ? " unit-field__unit--lead" : ""}`}>
      {unit}
    </span>
  );
  return (
    <span className={`unit-field${wide ? " unit-field--wide" : ""}`}>
      {unitFirst && unitEl}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= min) {
            onChange(max !== undefined && n > max ? max : n);
          }
        }}
        onBlur={() => setText(String(value))}
      />
      {!unitFirst && unitEl}
    </span>
  );
}

/** Search-and-add, with the chosen countries as chips beneath. */
export function CountryPicker({
  selected,
  onChange,
  emptyHint,
}: {
  selected: string[];
  onChange: (codes: string[]) => void;
  emptyHint?: string;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => searchCountries(query, selected), [query, selected]);

  const add = (code: string) => {
    onChange([...selected, code]);
    setQuery("");
  };

  return (
    <div className="cpick">
      <div className="cpick__search">
        <div className="search">
          <span className="search__icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="text"
            value={query}
            placeholder="Search countries"
            aria-label="Search countries"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) {
                e.preventDefault();
                add(matches[0].code);
              }
              if (e.key === "Escape") setQuery("");
            }}
          />
          {query && (
            <button
              type="button"
              className="search__clear"
              aria-label="Clear"
              onClick={() => setQuery("")}
            >
              ×
            </button>
          )}
        </div>
        {query.trim() !== "" && (
          <div className="cpick__menu" role="listbox">
            {matches.length === 0 ? (
              <div className="cpick__empty">No country matches "{query}".</div>
            ) : (
              matches.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="cpick__option"
                  onClick={() => add(c.code)}
                >
                  <span aria-hidden="true">{c.flag}</span>
                  {c.name}
                  <span className="cpick__code">{c.code}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {selected.length > 0 ? (
        <div className="chips">
          {selected.map((code) => (
            <span key={code} className="chip cchip">
              <span aria-hidden="true">{flagOf(code)}</span>
              {countryName(code)}
              <button
                type="button"
                className="cchip__x"
                aria-label={`Remove ${countryName(code)}`}
                onClick={() => onChange(selected.filter((c) => c !== code))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : emptyHint ? (
        <p className="settings-row__hint" style={{ marginTop: 10 }}>
          {emptyHint}
        </p>
      ) : null}
    </div>
  );
}
