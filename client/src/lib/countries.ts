/**
 * The countries a return policy can be drawn around.
 *
 * ISO 3166-1 alpha-2, the same codes Shopify puts on a shipping address, plus
 * the three Shopify also ships to: Kosovo, Ascension Island and Tristan da
 * Cunha. Names come from the browser's own locale data rather than a table
 * here, so they're spelled the way the merchant's browser spells them and a
 * newly recognised region needs no release to be named.
 */
const CODES = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK AC TA`.split(
  " ",
);

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

/** "France" for "FR"; the code itself when the browser can't name it. */
export const countryName = (code: string): string => {
  try {
    return displayNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

/**
 * The flag as an emoji: two regional-indicator letters, which every platform
 * that has flags renders as one. A platform without them shows the letters,
 * which still says which country it is.
 */
export const flagOf = (code: string): string =>
  String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );

export interface Country {
  code: string;
  name: string;
  flag: string;
}

export const COUNTRIES: Country[] = CODES.map((code) => ({
  code,
  name: countryName(code),
  flag: flagOf(code),
})).sort((a, b) => a.name.localeCompare(b.name));

/**
 * The countries matching what's been typed, for the picker — by name first,
 * then by code, so "de" finds Germany before Denmark falls in by its name.
 */
export const searchCountries = (
  query: string,
  exclude: string[] = [],
  limit = 8,
): Country[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const skip = new Set(exclude);
  const byName = COUNTRIES.filter(
    (c) => !skip.has(c.code) && c.name.toLowerCase().includes(q),
  );
  const byCode = COUNTRIES.filter(
    (c) =>
      !skip.has(c.code) &&
      c.code.toLowerCase() === q &&
      !byName.includes(c),
  );
  return [...byCode, ...byName].slice(0, limit);
};
