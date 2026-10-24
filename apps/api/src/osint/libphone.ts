/**
 * Adapter real google-libphonenumber (portagem npm do libphonenumber do Google).
 * E.164, tipo e região — nada mais é afirmado sem fonte.
 * O pacote é CJS: import default + destructuring (named exports quebram no ESM/tsx).
 */
import libphonenumber from "google-libphonenumber";

const { PhoneNumberUtil, PhoneNumberType, PhoneNumberFormat } = libphonenumber;

const util = PhoneNumberUtil.getInstance();

export interface ParsedPhone {
  valid: boolean;
  e164?: string | undefined;
  region?: string | null | undefined;
  type?: string | null | undefined;
  national?: string | undefined;
}

const TYPE_NAMES: Record<number, string> = {
  [PhoneNumberType.FIXED_LINE]: "FIXED_LINE",
  [PhoneNumberType.MOBILE]: "MOBILE",
  [PhoneNumberType.FIXED_LINE_OR_MOBILE]: "FIXED_LINE_OR_MOBILE",
  [PhoneNumberType.TOLL_FREE]: "TOLL_FREE",
  [PhoneNumberType.PREMIUM_RATE]: "PREMIUM_RATE",
  [PhoneNumberType.SHARED_COST]: "SHARED_COST",
  [PhoneNumberType.VOIP]: "VOIP",
  [PhoneNumberType.PERSONAL_NUMBER]: "PERSONAL_NUMBER",
  [PhoneNumberType.PAGER]: "PAGER",
  [PhoneNumberType.UAN]: "UAN",
  [PhoneNumberType.VOICEMAIL]: "VOICEMAIL",
  [PhoneNumberType.UNKNOWN]: "UNKNOWN",
};

export function parsePhone(raw: string, region: string): ParsedPhone {
  try {
    const number = util.parse(raw, region);
    const valid = util.isValidNumber(number);
    if (!valid) return { valid: false };
    return {
      valid: true,
      e164: util.format(number, PhoneNumberFormat.E164),
      region: util.getRegionCodeForNumber(number),
      type: TYPE_NAMES[util.getNumberType(number)] ?? "UNKNOWN",
      national: util.format(number, PhoneNumberFormat.NATIONAL),
    };
  } catch {
    return { valid: false };
  }
}
