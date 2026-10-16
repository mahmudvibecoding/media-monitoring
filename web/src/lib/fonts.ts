import { Inter } from "next/font/google";

// Inter has every letter the three languages use, Uzbek's ʻ (oʻ, gʻ) and Cyrillic Ў, Қ, Ғ, Ҳ included. Next serves it
// from this server; its Latin and Cyrillic letters load with a page, the rest when a page uses them.
export const inter = Inter({ subsets: ["latin", "cyrillic"], variable: "--font-sans" });
