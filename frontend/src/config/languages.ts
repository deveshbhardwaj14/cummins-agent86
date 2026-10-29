export type ConversationLanguage = {
  code: string;
  label: string;
  nativeName: string;
};

// Azure Speech real-time transcription locales:
// https://learn.microsoft.com/azure/ai-services/speech-service/language-support?tabs=stt
const locales = [
  "af-ZA", "am-ET", "ar-AE", "ar-BH", "ar-DZ", "ar-EG", "ar-IL", "ar-IQ",
  "ar-JO", "ar-KW", "ar-LB", "ar-LY", "ar-MA", "ar-OM", "ar-PS", "ar-QA",
  "ar-SA", "ar-SY", "ar-TN", "ar-YE", "as-IN", "az-AZ", "bg-BG", "bho-IN",
  "bn-IN", "bs-BA", "ca-ES", "cs-CZ", "cy-GB", "da-DK", "de-AT", "de-CH",
  "de-DE", "el-GR", "en-AU", "en-CA", "en-GB", "en-GH", "en-HK", "en-IE",
  "en-IN", "en-KE", "en-NG", "en-NZ", "en-PH", "en-SG", "en-TZ", "en-US",
  "en-ZA", "es-AR", "es-BO", "es-CL", "es-CO", "es-CR", "es-CU", "es-DO",
  "es-EC", "es-ES", "es-GQ", "es-GT", "es-HN", "es-MX", "es-NI", "es-PA",
  "es-PE", "es-PR", "es-PY", "es-SV", "es-US", "es-UY", "es-VE", "et-EE",
  "eu-ES", "fa-IR", "fi-FI", "fil-PH", "fr-BE", "fr-CA", "fr-CH", "fr-FR",
  "ga-IE", "gl-ES", "gu-IN", "he-IL", "hi-IN", "hr-HR", "hu-HU", "hy-AM",
  "id-ID", "is-IS", "it-CH", "it-IT", "ja-JP", "jv-ID", "ka-GE", "kk-KZ",
  "km-KH", "kn-IN", "ko-KR", "lo-LA", "lt-LT", "lv-LV", "mk-MK", "ml-IN",
  "mn-MN", "mr-IN", "ms-MY", "mt-MT", "my-MM", "nb-NO", "ne-NP", "nl-BE",
  "nl-NL", "or-IN", "pa-IN", "pl-PL", "ps-AF", "pt-BR", "pt-PT", "ro-RO",
  "ru-RU", "si-LK", "sk-SK", "sl-SI", "so-SO", "sq-AL", "sr-ME", "sr-RS",
  "sr-XK", "sv-SE", "sw-KE", "sw-TZ", "ta-IN", "te-IN", "th-TH", "tr-TR",
  "uk-UA", "ur-IN", "uz-UZ", "vi-VN", "wuu-CN", "yue-CN", "zh-CN",
  "zh-CN-shandong", "zh-CN-sichuan", "zh-HK", "zh-TW", "zu-ZA",
];

const englishNames = new Intl.DisplayNames(["en"], { type: "language" });

export const LANGUAGES: ConversationLanguage[] = locales.map((code) => ({
  code,
  label: code === "en-US" ? "English (United States)" : (englishNames.of(code) || code),
  nativeName: new Intl.DisplayNames([code], { type: "language" }).of(code.split("-")[0]) || code,
})).sort((a, b) => a.label.localeCompare(b.label, "en"));

export const DEFAULT_LANGUAGE = LANGUAGES.find((language) => language.code === "en-US")!;

export function filterLanguages(query: string): ConversationLanguage[] {
  const normalize = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const search = normalize(query.trim());
  return LANGUAGES.filter((language) =>
    normalize(`${language.label} ${language.nativeName} ${language.code}`).includes(search),
  );
}
