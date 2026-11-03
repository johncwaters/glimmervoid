export const TIP_LABEL_MAX_CHARS = 40;
export const TIP_DETAIL_MAX_CHARS = 96;

const ELLIPSIS = String.fromCharCode(0x2026);
const MIN_KEPT_SHARE_AT_WORD_BOUNDARY = 0.75;

declare const fittedTipTextBrand: unique symbol;
export type FittedTipText = string & { readonly [fittedTipTextBrand]: true };

type IsLongerThan<Text extends string, MaxChars extends number, Counted extends unknown[] = []> =
  Text extends '' ? false
    : Counted['length'] extends MaxChars ? true
      : Text extends `${infer Head}${infer Rest}`
        ? IsOpenHole<Head> extends true ? true : IsLongerThan<Rest, MaxChars, [...Counted, unknown]>
        : true;

type IsOpenHole<Head extends string> = string extends Head ? true : `${number}` extends Head ? true : `${bigint}` extends Head ? true : false;

type CheckedTipText<Text extends string, MaxChars extends number, Refusal extends string> =
  Text extends FittedTipText ? Text
    : string extends Text ? Refusal
      : IsLongerThan<Text, MaxChars> extends true ? Refusal : Text;

export type TipLabel<Text extends string> = CheckedTipText<Text, typeof TIP_LABEL_MAX_CHARS, 'Tip label must be a literal of at most 40 characters, or fitTipLabel(text)'>;
export type TipDetail<Text extends string> = CheckedTipText<Text, typeof TIP_DETAIL_MAX_CHARS, 'Tip detail must be a literal of at most 96 characters, or fitTipDetail(text)'>;

function clampTipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const prefix = text.slice(0, maxChars - 1);
  const wordBoundary = text[maxChars - 1] === ' ' ? prefix.length : prefix.lastIndexOf(' ');
  const isBoundaryCloseEnough = wordBoundary >= prefix.length * MIN_KEPT_SHARE_AT_WORD_BOUNDARY;
  return `${prefix.slice(0, isBoundaryCloseEnough ? wordBoundary : prefix.length).trimEnd()}${ELLIPSIS}`;
}

export function fitTipLabel(text: string): FittedTipText {
  return clampTipText(text, TIP_LABEL_MAX_CHARS) as FittedTipText;
}

export function fitTipDetail(text: string): FittedTipText {
  return clampTipText(text, TIP_DETAIL_MAX_CHARS) as FittedTipText;
}
