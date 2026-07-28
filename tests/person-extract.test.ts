import { describe, it, expect } from "vitest";
import { extractPerson, normalizeLinkedIn, personSearchQuery } from "@/lib/outreach/person";

// Taken from a real ctodirectory.com profile. The ordering is the point: the
// site's own Organization block comes first, so an extractor that reads
// json[0] returns the directory instead of the person.
const REAL_PROFILE = `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Organization","name":"StackUp",
 "url":"https://stackup.tech","description":"StackUp gives boards clarity."}
</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Person","name":"Marc van Neerven",
 "jobTitle":"Chief Technology Officer",
 "description":"Startup Intelligence Officer - I help founders make better decisions.",
 "image":"https://example.test/photo.jpg"}
</script>
<meta property="og:title" content="Marc van Neerven - Chief Technology Officer | Fractional CTO Directory">
<meta name="description" content="Startup Intelligence Officer">
<title>Marc van Neerven - Chief Technology Officer | Fractional CTO Directory</title>
</head><body><h1>Marc van Neerven</h1></body></html>`;

describe("extractPerson on a real directory profile", () => {
  const person = extractPerson(REAL_PROFILE);

  it("picks the Person, not the site's own Organization", () => {
    // json[0] is StackUp. Reading it would attribute every profile on the
    // site to the directory's parent company.
    expect(person?.fullName).toBe("Marc van Neerven");
    expect(person?.fullName).not.toBe("StackUp");
  });

  it("reads the job title", () => {
    expect(person?.jobTitle).toBe("Chief Technology Officer");
  });

  it("prefers structured data over the title tag", () => {
    expect(person?.source).toBe("json-ld");
  });

  it("does not invent an employer the page never stated", () => {
    // "Fractional CTO Directory" is the site, not where he works.
    expect(person?.company).toBeNull();
  });
});

describe("richer structured data", () => {
  const html = `<script type="application/ld+json">{
    "@context":"https://schema.org","@type":"Person","name":"Jane Doe",
    "jobTitle":"VP Engineering",
    "worksFor":{"@type":"Organization","name":"Acme Robotics","url":"https://acme.test"},
    "address":{"@type":"PostalAddress","addressLocality":"Bristol","addressCountry":"UK"},
    "sameAs":["https://www.linkedin.com/in/janedoe","https://github.com/janedoe"]
  }</script>`;
  const p = extractPerson(html);

  it("reads employer and their site", () => {
    expect(p?.company).toBe("Acme Robotics");
    expect(p?.companySite).toBe("https://acme.test");
  });

  it("reads location from a structured address", () => {
    expect(p?.location).toBe("Bristol, UK");
  });

  it("pulls LinkedIn out of sameAs", () => {
    expect(p?.linkedinUrl).toBe("https://www.linkedin.com/in/janedoe");
    expect(p?.socials.github).toBe("https://github.com/janedoe");
  });

  it("handles an @graph wrapper", () => {
    const graph = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"WebSite","name":"Some Directory"},
      {"@type":"Person","name":"Sam Patel","jobTitle":"CTO"}]}</script>`;
    expect(extractPerson(graph)?.fullName).toBe("Sam Patel");
  });
});

describe("meta fallback", () => {
  const TITLE = `<meta property="og:title" content="Chris Sprucefield - Fractional CTO | CTO Directory">`;
  const PROFILE_URL = "https://ctodirectory.com/profile/chris-sprucefield-m8phr9";

  it("parses the Name - Title | Site convention on a profile URL", () => {
    const p = extractPerson(TITLE, PROFILE_URL);
    expect(p?.fullName).toBe("Chris Sprucefield");
    expect(p?.jobTitle).toBe("Fractional CTO");
    expect(p?.source).toBe("meta");
  });

  it("drops the site segment rather than treating it as an employer", () => {
    expect(extractPerson(TITLE, PROFILE_URL)?.company).toBeNull();
  });

  it("accepts og:type=profile in place of a profile URL", () => {
    const html = `<meta property="og:type" content="profile">${TITLE}`;
    expect(extractPerson(html, "https://example.test/x")?.fullName).toBe("Chris Sprucefield");
  });

  it("refuses the same title on a page that never claims to be a profile", () => {
    // Without a profile signal the shape of a title is not evidence about
    // whether the page is about a person.
    expect(extractPerson(TITLE, "https://ctodirectory.com/about")).toBeNull();
  });
});

describe("headings that a live run mistook for people", () => {
  // All four were extracted as contacts from ctodirectory.com marketing
  // pages: capitalised, two to four words, and not human beings. A
  // fabricated name reaches a real inbox addressed to nobody.
  const notPeople = [
    "AI Leadership Sprint",
    "For Fractional CTOs",
    "For CEOs and Founders",
    "For Board Members",
  ];

  for (const heading of notPeople) {
    it(`rejects "${heading}"`, () => {
      const html = `<meta property="og:type" content="profile"><title>${heading}</title>`;
      expect(extractPerson(html, "https://ctodirectory.com/profile/x")).toBeNull();
    });
  }

  it("still accepts a real name with a lowercase particle", () => {
    const html = `<title>Marc van Neerven - Chief Technology Officer | Directory</title>`;
    expect(extractPerson(html, "https://ctodirectory.com/profile/marc-van-neerven-7lisfl")?.fullName)
      .toBe("Marc van Neerven");
  });
});

describe("refusing to invent a person", () => {
  // Putting a fabricated name into a cold email is worse than extracting
  // nothing, so anything that doesn't look like a person returns null.
  it("returns null for a page with no person at all", () => {
    expect(extractPerson("<html><body><p>Just a page</p></body></html>")).toBeNull();
  });

  it("returns null for a headline rather than a name", () => {
    const html = `<title>The Top 500 CTOs To Watch In America This Year</title>`;
    expect(extractPerson(html)).toBeNull();
  });

  it("returns null for a one-word title", () => {
    expect(extractPerson(`<title>Directory</title>`)).toBeNull();
  });

  it("ignores an Organization-only page", () => {
    const html = `<script type="application/ld+json">{"@type":"Organization","name":"StackUp"}</script>`;
    expect(extractPerson(html)).toBeNull();
  });
});

describe("personSearchQuery", () => {
  it("quotes the name and adds the employer as a discriminator", () => {
    const q = personSearchQuery({
      fullName: "Jane Doe",
      jobTitle: "VP Engineering",
      company: "Acme Robotics",
      companySite: null,
      description: null,
      linkedinUrl: null,
      socials: {},
      location: null,
      source: "json-ld",
    });
    expect(q).toContain('"Jane Doe"');
    expect(q).toContain('"Acme Robotics"');
  });

  it("falls back to job title when there is no employer", () => {
    const q = personSearchQuery({
      fullName: "Marc van Neerven",
      jobTitle: "Chief Technology Officer",
      company: null,
      companySite: null,
      description: null,
      linkedinUrl: null,
      socials: {},
      location: null,
      source: "json-ld",
    });
    expect(q).toContain('"Marc van Neerven"');
    expect(q).toContain("Chief Technology Officer");
  });
});

describe("normalizeLinkedIn", () => {
  it("rejects the logged-in settings URL people actually paste", () => {
    // Copied verbatim from a live ctodirectory profile. It renders as a
    // LinkedIn link and opens nothing for anyone else.
    const pasted =
      "https://www.linkedin.com/public-profile/settings/?trk=d_flagship3_profile_self_view_public_profile&lipi=urn%3Ali%3Apage%3Ad_flagship3";
    expect(normalizeLinkedIn(pasted)).toBeNull();
  });

  it("keeps a real profile and strips tracking parameters", () => {
    expect(normalizeLinkedIn("https://www.linkedin.com/in/mvneerven/?trk=abc")).toBe(
      "https://www.linkedin.com/in/mvneerven",
    );
  });

  it("accepts company pages", () => {
    expect(normalizeLinkedIn("https://linkedin.com/company/acme")).toBe(
      "https://www.linkedin.com/company/acme",
    );
  });

  it("rejects a non-LinkedIn host that merely contains the word", () => {
    expect(normalizeLinkedIn("https://notlinkedin.com.evil.test/in/someone")).toBeNull();
  });
});
