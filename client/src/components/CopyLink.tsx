import { useEffect, useRef, useState } from "react";

/**
 * A read-only URL with a copy button.
 *
 * The field is an `<input>` rather than text so the URL can still be selected
 * by hand — clipboard access is denied outright in some browsers and on any
 * page that isn't on HTTPS, and a link the merchant can't get out of the screen
 * would be useless. `document.execCommand` is the fallback for exactly those
 * cases; it is deprecated but still the only thing that works there.
 */
export function CopyLink({ url, label }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    field.current?.select();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      document.execCommand("copy");
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="copy-link">
      {label && <div className="copy-link__label">{label}</div>}
      <div className="copy-link__row">
        <input
          ref={field}
          className="copy-link__field"
          value={url}
          readOnly
          aria-label={label ?? "Link"}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          className="btn btn--secondary btn--sm"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Open
        </a>
      </div>
    </div>
  );
}
