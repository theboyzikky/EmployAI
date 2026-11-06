// Small text helpers shared by the offline consultant, the analysis and the merge step.

/** Brand and product names with their official capitalisation. */
const BRANDS: Array<[RegExp, string]> = [
  [/\bwhats\s?app business\b/gi, "WhatsApp Business"],
  [/\bwhats\s?app\b/gi, "WhatsApp"],
  [/\binstagram\b/gi, "Instagram"],
  [/\bfacebook\b/gi, "Facebook"],
  [/\btik\s?tok\b/gi, "TikTok"],
  [/\byoutube\b/gi, "YouTube"],
  [/\blinked\s?in\b/gi, "LinkedIn"],
  [/\bgoogle sheets\b/gi, "Google Sheets"],
  [/\bgoogle calendar\b/gi, "Google Calendar"],
  [/\bgoogle maps\b/gi, "Google Maps"],
  [/\bgmail\b/gi, "Gmail"],
  [/\bexcel\b/gi, "Excel"],
  [/\bquick\s?books\b/gi, "QuickBooks"],
  [/\bxero\b/gi, "Xero"],
  [/\bshopify\b/gi, "Shopify"],
  [/\bwoo\s?commerce\b/gi, "WooCommerce"],
  [/\bsquarespace\b/gi, "Squarespace"],
  [/\bpaystack\b/gi, "Paystack"],
  [/\bflutterwave\b/gi, "Flutterwave"],
  [/\bopay\b/gi, "OPay"],
  [/\bpaypal\b/gi, "PayPal"],
  [/\bstripe\b/gi, "Stripe"],
  [/\buber\s?eats\b/gi, "Uber Eats"],
  [/\bglovo\b/gi, "Glovo"],
  [/\bchowdeck\b/gi, "Chowdeck"],
  [/\bjumia\b/gi, "Jumia"],
  [/\bdeliveroo\b/gi, "Deliveroo"],
  [/\bcalendly\b/gi, "Calendly"],
  [/\bfresha\b/gi, "Fresha"],
  [/\bbooksy\b/gi, "Booksy"],
  [/\biphone\b/gi, "iPhone"],
  [/\bpos\b/g, "POS"],
];

export function normalizeBrands(text: string): string {
  let out = text;
  for (const [re, name] of BRANDS) out = out.replace(re, name);
  return out;
}

const KEEP_CASE = /^(?:[A-Z]{2,}|[A-Z][a-z]+[A-Z]\w*|i[A-Z]\w*|WhatsApp|Instagram|Facebook|TikTok|YouTube|LinkedIn|Google|Gmail|Excel|QuickBooks|Xero|Shopify|WooCommerce|Squarespace|Paystack|Flutterwave|PayPal|Stripe|Uber|Glovo|Chowdeck|Jumia|Deliveroo|Calendly|Fresha|Booksy|I)\b/;

/** Lower-case the first letter for use mid-sentence, unless the first word is a name or acronym. */
export function lowerFirst(text: string): string {
  if (!text || KEEP_CASE.test(text)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Upper-case the first letter (for values shown on their own). */
export function upperFirst(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
