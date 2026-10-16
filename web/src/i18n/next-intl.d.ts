import type ru from "../../messages/ru.json";
import type { Locale } from "./config";

// Texts are looked up by key, checked against ru.json: a key that isn't there fails the typecheck
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof ru;
  }
}
