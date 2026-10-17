import type en from "../../messages/en.json";
import type { Locale } from "./config";

// Texts are looked up by key, checked against en.json, the one with every text (the activity is only in English): a
// key that isn't there fails the typecheck
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof en;
  }
}
