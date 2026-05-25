import localFont from "next/font/local";

export const datatypeFont = localFont({
  src: "../app/fonts/Datatype.woff2",
  display: "swap",
  weight: "100 900",
  preload: true,
  variable: "--font-datatype",
});
