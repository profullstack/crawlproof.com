import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PricingPage, { metadata } from "@/app/(marketing)/pricing/page";
import { SoftwareApplicationJsonLd } from "@/components/json-ld";
import { GET } from "@/app/llms.txt/route";

describe("published pricing", () => {
  it("renders all four new pack totals and the exact credit prices", () => {
    const html = renderToStaticMarkup(createElement(PricingPage));
    for (const price of ["$6", "$54", "$210", "$300"]) {
      expect(html).toContain(`>${price}<`);
    }
    for (const price of ["$0.30", "$0.27", "$0.21", "$0.15"]) {
      expect(html).toContain(`>${price}/credit<`);
    }
    expect(metadata.description).toContain("20 credits ($6)");
    expect(metadata.description).toContain("$3 per scan");
    expect(html).not.toContain("~$1");
  });

  it("uses scan equivalents rather than credit counts in structured offers", () => {
    const html = renderToStaticMarkup(createElement(SoftwareApplicationJsonLd));
    const json = JSON.parse(html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>")));
    expect(json.offers.map((offer: { price: string }) => offer.price)).toEqual(["0", "6.00", "54.00", "210.00", "300.00"]);
    expect(json.offers.at(-1).description).toBe("2000 credits · 100 scans · $3/scan");
  });

  it("serves the same prices to agents", async () => {
    const text = await (await GET()).text();
    expect(text).toContain("20 credits ($6 before volume discounts, down to $3/scan");
    expect(text).not.toContain("$0.50/scan");
  });
});
