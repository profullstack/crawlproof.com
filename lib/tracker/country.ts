const countryDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryNameFromCode(code: string | null | undefined) {
  const clean = code?.trim().toUpperCase();
  if (!clean || !/^[A-Z]{2}$/.test(clean)) return "";
  try {
    return countryDisplayNames.of(clean) ?? "";
  } catch {
    return "";
  }
}
