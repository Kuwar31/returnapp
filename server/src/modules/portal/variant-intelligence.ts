/**
 * Which variant answers a return reason.
 *
 * The heart of "AI exchange": given why an item is coming back — the reason
 * the shopper chose and whatever they wrote beside it — and the variants the
 * product comes in, pick the one that fixes the problem. "Too small" is the
 * next size up in the same colour; "too long" is the same waist in a shorter
 * leg; "arrived damaged" is the very same variant again; "wanted it darker"
 * is the same size in a darker colour that's in stock.
 *
 * Pure, so the rules can be read and tested on their own. Nothing here is
 * learned from other shoppers — that signal is passed in as `history` and
 * used as a tie-breaker and a fallback, never as a reason to override what
 * the shopper actually said.
 */

export interface VariantLike {
  id: string;
  available: boolean;
  options: Array<{ name: string; value: string }>;
}

export type Direction = "UP" | "DOWN";

export interface Intent {
  /** Fix the size: up for "too small", down for "too large". */
  size: Direction | null;
  /** Fix the length on its own axis, when the product has one. */
  length: Direction | null;
  /** They want a different colour — a named one, a shade, or just another. */
  color: { named: string | null; shade: "LIGHTER" | "DARKER" | null } | null;
  /** The item was right and the unit wasn't: send the same variant again. */
  replacement: boolean;
}

export type RationaleKind =
  | "SIZE_UP"
  | "SIZE_DOWN"
  | "SHORTER"
  | "LONGER"
  | "COLOR"
  | "REPLACEMENT"
  | "HISTORY";

export interface VariantPick {
  variantId: string;
  rationale: { kind: RationaleKind; from?: string };
}

// ---------------------------------------------------------------- reading intent

const REPLACEMENT =
  /damag|defect|broken|faulty|torn|ripped|stain|scratch|crack|wrong item|incorrect item|not what i ordered|missing (a |the )?(part|piece)|doesn'?t work|not working|arrived (damaged|broken)/;

/** Specific phrases first: "runs small" must not read as "small". */
const SIZE_UP =
  /too small|too tight|runs small|fits small|size up|bigger size|larger size|a size up|\btight|snug|\bsmall\b|\bpetite\b/;
const SIZE_DOWN =
  /too large|too big|too loose|runs large|runs big|fits large|size down|smaller size|a size down|\bloose|baggy|\blarge\b|\bbig\b|\bwide\b/;
const TOO_LONG = /too long|shorter (leg|length|inseam)/;
const TOO_SHORT = /too short|longer (leg|length|inseam)/;

const COLOR_WORD = /colou?r|shade|hue|farbe|couleur|kleur|colore|cor\b|kolor|färg|farve/;
const LIGHTER = /lighter|brighter|paler|light(er)? (colou?r|shade)/;
const DARKER = /darker|deeper|dark(er)? (colou?r|shade)/;

/**
 * Colour names and how light they read, 0 (black) to 1 (white). Used two
 * ways: to spot a colour the shopper named in a comment, and to answer
 * "darker" or "lighter" against the colour they have. Approximate on
 * purpose — nobody needs "navy" placed to three decimals, only below
 * "sky blue".
 */
const COLOR_LIGHTNESS: Record<string, number> = {
  black: 0.05, charcoal: 0.2, graphite: 0.2, ebony: 0.05, onyx: 0.05,
  navy: 0.15, midnight: 0.1, ink: 0.1, burgundy: 0.25, maroon: 0.25,
  wine: 0.25, plum: 0.3, purple: 0.35, violet: 0.4, indigo: 0.25,
  brown: 0.3, chocolate: 0.25, coffee: 0.25, espresso: 0.15, mocha: 0.35,
  olive: 0.35, forest: 0.25, hunter: 0.25, emerald: 0.4, green: 0.45,
  teal: 0.4, petrol: 0.3, blue: 0.5, cobalt: 0.4, royal: 0.4, denim: 0.45,
  red: 0.45, crimson: 0.35, scarlet: 0.45, rust: 0.4, orange: 0.6,
  coral: 0.65, salmon: 0.7, pink: 0.75, blush: 0.85, rose: 0.7,
  mustard: 0.6, gold: 0.65, yellow: 0.85, lemon: 0.9, lime: 0.75,
  mint: 0.85, sage: 0.65, khaki: 0.6, tan: 0.65, camel: 0.65,
  beige: 0.8, sand: 0.8, stone: 0.7, taupe: 0.6, grey: 0.6, gray: 0.6,
  silver: 0.75, sky: 0.8, aqua: 0.8, lavender: 0.8, lilac: 0.8,
  cream: 0.92, ivory: 0.95, white: 1, natural: 0.85, nude: 0.8,
};

const COLOR_NAMES = Object.keys(COLOR_LIGHTNESS);

/** The named colour in a phrase, if any: "the navy one" → "navy". */
const namedColorIn = (text: string): string | null => {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.find((w) => COLOR_NAMES.includes(w)) ?? null;
};

/** How light a merchant's colour value reads, from any colour word inside it. */
export const lightnessOf = (value: string): number | null => {
  const found = namedColorIn(value);
  return found ? COLOR_LIGHTNESS[found] : null;
};

/**
 * What the shopper wants, read from the reason and the comment together.
 *
 * The reason is the merchant's wording of a category; the comment is the
 * shopper's own, and often carries the detail — "fine in the waist, too long
 * in the leg", "wanted the black". Both are read, and a comment can add a
 * colour wish to a size reason. A comment that names a colour is taken as a
 * colour wish even without the word "colour".
 */
export const readIntent = (reason: string, comment = ""): Intent => {
  const text = `${reason} ${comment}`.toLowerCase();
  const replacement = REPLACEMENT.test(text);

  let length: Direction | null = null;
  if (TOO_LONG.test(text)) length = "DOWN";
  else if (TOO_SHORT.test(text)) length = "UP";

  let size: Direction | null = null;
  // "Too small" beats a stray "large" later in the sentence, so the more
  // specific phrase is looked for before the bare word.
  const up = text.search(SIZE_UP);
  const down = text.search(SIZE_DOWN);
  if (up >= 0 && (down < 0 || up <= down)) size = "UP";
  else if (down >= 0) size = "DOWN";

  const named = namedColorIn(comment);
  const shade: "LIGHTER" | "DARKER" | null = DARKER.test(text)
    ? "DARKER"
    : LIGHTER.test(text)
      ? "LIGHTER"
      : null;
  const color =
    named || shade || COLOR_WORD.test(text)
      ? { named, shade }
      : null;

  return { size, length, color, replacement };
};

// ---------------------------------------------------------------- reading variants

const SIZE_AXIS = /size|taille|größe|grösse|talla|tamanho|maat|storlek|størrelse|rozmiar|misura|サイズ|尺码|مقاس/i;
const LENGTH_AXIS = /length|inseam|\bleg\b|inside leg|längd|længde|lunghezza|longueur|długość/i;
const COLOR_AXIS = /colou?r|couleur|farbe|kleur|colore|cor\b|kolor|färg|farve|色|颜色|لون/i;

/** Where a size sits on the ladder. Letters and numbers both, "2XL" too. */
const LETTER_SIZES: Record<string, number> = {
  xxxs: 0, "3xs": 0, xxs: 1, "2xs": 1, xs: 2, s: 3, small: 3, m: 4, medium: 4,
  l: 5, large: 5, xl: 6, xxl: 7, "2xl": 7, xxxl: 8, "3xl": 8, "4xl": 9,
  "5xl": 10, "6xl": 11,
};

export const sizeRank = (value: string): number | null => {
  const v = value.trim().toLowerCase().replace(/\s+/g, "");
  if (v in LETTER_SIZES) return LETTER_SIZES[v];
  // "38", "9.5", "W32", "32W", "10-12" (take the first number).
  const num = v.match(/\d+(\.\d+)?/);
  if (num) return 100 + parseFloat(num[0]);
  return null;
};

const norm = (s: string) => s.trim().toLowerCase();

/** The option axes a product has, each with its values in the order they appear. */
const axesOf = (variants: VariantLike[]): Map<string, string[]> => {
  const axes = new Map<string, string[]>();
  for (const v of variants) {
    for (const o of v.options ?? []) {
      if (norm(o.name) === "title") continue;
      const values = axes.get(o.name) ?? [];
      if (!values.includes(o.value)) values.push(o.value);
      axes.set(o.name, values);
    }
  }
  return axes;
};

/**
 * The axis that carries size, by name or — failing that — by looking like
 * one: mostly values a size ladder can place.
 */
const findAxis = (
  axes: Map<string, string[]>,
  byName: RegExp,
  byValues?: (values: string[]) => boolean,
): string | null => {
  for (const name of axes.keys()) if (byName.test(name)) return name;
  if (byValues) {
    for (const [name, values] of axes) if (byValues(values)) return name;
  }
  return null;
};

const looksSized = (values: string[]) =>
  values.length >= 2 &&
  values.filter((v) => sizeRank(v) !== null).length / values.length >= 0.6;

/**
 * The next value along an axis in one direction. Ranked when the values can
 * be ranked, otherwise in the order the merchant listed them — which, for
 * sizes, is nearly always ascending.
 */
const stepAlong = (
  values: string[],
  from: string,
  direction: Direction,
  steps = 1,
): string | null => {
  const ranks = values.map(sizeRank);
  const ordered =
    ranks.every((r) => r !== null)
      ? [...values].sort((a, b) => sizeRank(a)! - sizeRank(b)!)
      : values;
  const at = ordered.findIndex((v) => norm(v) === norm(from));
  if (at < 0) return null;
  const target = direction === "UP" ? at + steps : at - steps;
  return target >= 0 && target < ordered.length ? ordered[target] : null;
};

const optionValue = (v: VariantLike, axis: string): string | undefined =>
  v.options.find((o) => o.name === axis)?.value;

/** The variant whose options match `wanted` on every axis named in it. */
const variantWith = (
  variants: VariantLike[],
  wanted: Map<string, string>,
): VariantLike | undefined =>
  variants.find((v) =>
    [...wanted].every(([axis, value]) => norm(optionValue(v, axis) ?? "") === norm(value)),
  );

// ---------------------------------------------------------------- the pick

/**
 * The variant that answers the intent, or null when there isn't a confident
 * one. Only in-stock variants are ever returned: a recommendation the
 * shopper can't take is worse than none, so the search steps further along
 * the ladder (up to two sizes) and across colours before giving up.
 *
 * `history` — how often other shoppers who returned this same variant for
 * the same reason ended up with each variant — breaks ties between equally
 * good answers and stands in when the reason carries no signal at all.
 */
export const recommendVariant = (
  variants: VariantLike[],
  currentVariantId: string | null,
  intent: Intent,
  history: Map<string, number> = new Map(),
): VariantPick | null => {
  const current = variants.find((v) => v.id === currentVariantId) ?? null;
  const axes = axesOf(variants);

  if (intent.replacement && current) {
    return current.available
      ? { variantId: current.id, rationale: { kind: "REPLACEMENT" } }
      : null;
  }

  if (current) {
    const sizeAxis = findAxis(axes, SIZE_AXIS, looksSized);
    const lengthAxis = findAxis(axes, LENGTH_AXIS);
    const colorAxis = findAxis(axes, COLOR_AXIS);

    /** What we're aiming for: the current options, altered by the intent. */
    const wanted = new Map(current.options.map((o) => [o.name, o.value]));
    let rationale: VariantPick["rationale"] | null = null;

    // A length complaint goes to the length axis when there is one; a
    // product with no such axis gets it folded into size instead.
    let size = intent.size;
    let length = intent.length;
    if (length && !lengthAxis) {
      size = size ?? length;
      length = null;
    }

    const stepAxis = (axis: string | null, direction: Direction | null) => {
      if (!axis || !direction) return null;
      const from = wanted.get(axis);
      if (!from) return null;
      for (let steps = 1; steps <= 2; steps++) {
        const next = stepAlong(axes.get(axis) ?? [], from, direction, steps);
        if (!next) break;
        const trial = new Map(wanted).set(axis, next);
        const hit = variantWith(variants, trial);
        if (hit?.available) return { value: next, from };
      }
      return null;
    };

    if (size && sizeAxis) {
      const stepped = stepAxis(sizeAxis, size);
      if (stepped) {
        wanted.set(sizeAxis, stepped.value);
        rationale = { kind: size === "UP" ? "SIZE_UP" : "SIZE_DOWN", from: stepped.from };
      }
    }
    if (length && lengthAxis) {
      const stepped = stepAxis(lengthAxis, length);
      if (stepped) {
        wanted.set(lengthAxis, stepped.value);
        rationale = rationale ?? { kind: length === "UP" ? "LONGER" : "SHORTER", from: stepped.from };
      }
    }

    if (intent.color && colorAxis) {
      const have = wanted.get(colorAxis) ?? "";
      const others = (axes.get(colorAxis) ?? []).filter((c) => norm(c) !== norm(have));
      const inStock = (c: string) => {
        const trial = new Map(wanted).set(colorAxis, c);
        return variantWith(variants, trial)?.available === true;
      };
      let pick: string | undefined;
      if (intent.color.named) {
        pick = others.find((c) => norm(c).includes(intent.color!.named!) && inStock(c));
      }
      if (!pick && intent.color.shade) {
        const mine = lightnessOf(have);
        const darker = intent.color.shade === "DARKER";
        pick = others
          .filter((c) => {
            const l = lightnessOf(c);
            return l !== null && mine !== null && (darker ? l < mine : l > mine) && inStock(c);
          })
          .sort((a, b) => (darker ? lightnessOf(b)! - lightnessOf(a)! : lightnessOf(a)! - lightnessOf(b)!))[0];
      }
      if (!pick) {
        // Any other colour, the most-chosen by history first.
        pick = others
          .filter(inStock)
          .sort((a, b) => {
            const count = (c: string) =>
              history.get(variantWith(variants, new Map(wanted).set(colorAxis, c))?.id ?? "") ?? 0;
            return count(b) - count(a);
          })[0];
      }
      if (pick) {
        wanted.set(colorAxis, pick);
        rationale = rationale ?? { kind: "COLOR", from: have };
      }
    }

    if (rationale) {
      const hit = variantWith(variants, wanted);
      if (hit?.available && hit.id !== current.id) {
        return { variantId: hit.id, rationale };
      }
    }
  }

  /**
   * No signal in the words, or nothing in stock that answers it: what other
   * shoppers did after the same reason, if enough of them agree. Two is the
   * floor — one shopper's choice is an anecdote.
   */
  const [top] = [...history.entries()]
    .filter(([id, n]) => n >= 2 && id !== currentVariantId)
    .filter(([id]) => variants.find((v) => v.id === id)?.available)
    .sort((a, b) => b[1] - a[1]);
  if (top) return { variantId: top[0], rationale: { kind: "HISTORY" } };

  return null;
};

/**
 * For a *different* product: the option the shopper would most likely want
 * of it, carrying their size across — one step along when the reason asked
 * for it. Null when the product has no matching axis; the card then opens
 * on nothing selected, as it would in the shop.
 */
export const carrySizeAcross = (
  variants: VariantLike[],
  currentOptions: Array<{ name: string; value: string }>,
  intent: Intent,
): string | null => {
  const axes = axesOf(variants);
  const sizeAxis = findAxis(axes, SIZE_AXIS, looksSized);
  if (!sizeAxis) return null;
  const mine = currentOptions.find((o) => SIZE_AXIS.test(o.name) || norm(o.name) === norm(sizeAxis))?.value;
  if (!mine) return null;
  const values = axes.get(sizeAxis) ?? [];
  let target: string | null = values.find((v) => norm(v) === norm(mine)) ?? null;
  if (!target) {
    // The same rung on a different ladder: match by rank when names differ.
    const rank = sizeRank(mine);
    target = rank === null ? null : (values.find((v) => sizeRank(v) === rank) ?? null);
  }
  if (target && intent.size) target = stepAlong(values, target, intent.size) ?? target;
  if (!target) return null;
  const hit = variants.find(
    (v) => v.available && norm(optionValue(v, sizeAxis) ?? "") === norm(target!),
  );
  return hit?.id ?? null;
};
