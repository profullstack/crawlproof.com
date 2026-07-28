import { describe, it, expect } from "vitest";
import {
  splitEmail,
  parseAutoconfig,
  parseAutodiscover,
  providerFromMx,
  isPrivateAddress,
  passwordNoteFor,
  type MailboxDiscovery,
} from "@/lib/outreach/mailboxDiscovery";

// A real Forward Email response, trimmed. Kept verbatim rather than
// hand-written so the parser is tested against what a server actually sends.
const FORWARD_EMAIL_AUTOCONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="forwardemail.net">
    <domain>forwardemail.net</domain>
    <displayName>Forward Email</displayName>
    <incomingServer type="imap">
      <hostname>imap.forwardemail.net</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <incomingServer type="pop3">
      <hostname>pop3.forwardemail.net</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.forwardemail.net</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

const FORWARD_EMAIL_AUTODISCOVER = `<?xml version="1.0" encoding="UTF-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response>
    <Account>
      <AccountType>email</AccountType>
      <Protocol>
        <Type>IMAP</Type>
        <Server>imap.forwardemail.net</Server>
        <Port>993</Port>
        <SSL>on</SSL>
        <LoginName>%EMAILADDRESS%</LoginName>
      </Protocol>
      <Protocol>
        <Type>POP3</Type>
        <Server>pop3.forwardemail.net</Server>
        <Port>995</Port>
        <SSL>on</SSL>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>smtp.forwardemail.net</Server>
        <Port>465</Port>
        <SSL>on</SSL>
        <LoginName>%EMAILADDRESS%</LoginName>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>`;

describe("splitEmail", () => {
  it("splits and lowercases a normal address", () => {
    expect(splitEmail("  Anthony@ProFullStack.com ")).toEqual({
      local: "anthony",
      domain: "profullstack.com",
    });
  });

  it("keeps the last @ so plus/quoted locals survive", () => {
    expect(splitEmail("a+b@example.com")?.local).toBe("a+b");
  });

  it("rejects malformed addresses", () => {
    for (const bad of ["", "nope", "@example.com", "a@", "a@localhost", "a b@example.com"]) {
      expect(splitEmail(bad)).toBeNull();
    }
  });
});

describe("parseAutoconfig", () => {
  const parsed = parseAutoconfig(
    FORWARD_EMAIL_AUTOCONFIG,
    "anthony@profullstack.com",
    "anthony",
  );

  it("reads the IMAP server and ignores pop3", () => {
    expect(parsed.imap).toEqual({
      protocol: "imap",
      host: "imap.forwardemail.net",
      port: 993,
      socket: "SSL",
      username: "anthony@profullstack.com",
    });
  });

  it("reads the SMTP server", () => {
    expect(parsed.smtp).toMatchObject({ host: "smtp.forwardemail.net", port: 465, socket: "SSL" });
  });

  it("expands the username template to the real address", () => {
    expect(parsed.smtp?.username).toBe("anthony@profullstack.com");
  });

  it("picks up the provider display name", () => {
    expect(parsed.providerName).toBe("Forward Email");
  });

  it("expands %EMAILLOCALPART% for hosts that use it", () => {
    const xml = FORWARD_EMAIL_AUTOCONFIG.replace(
      "<username>%EMAILADDRESS%</username>",
      "<username>%EMAILLOCALPART%</username>",
    );
    const local = parseAutoconfig(xml, "anthony@profullstack.com", "anthony");
    expect(local.imap?.username).toBe("anthony");
  });

  it("returns nulls rather than throwing on junk", () => {
    const junk = parseAutoconfig("<html>404</html>", "a@b.com", "a");
    expect(junk.imap).toBeNull();
    expect(junk.smtp).toBeNull();
  });
});

describe("parseAutodiscover", () => {
  const parsed = parseAutodiscover(
    FORWARD_EMAIL_AUTODISCOVER,
    "anthony@profullstack.com",
    "anthony",
  );

  it("reads IMAP and SMTP and skips POP3", () => {
    expect(parsed.imap).toMatchObject({ host: "imap.forwardemail.net", port: 993 });
    expect(parsed.smtp).toMatchObject({ host: "smtp.forwardemail.net", port: 465 });
  });

  it("maps <SSL>on</SSL> to a socket type using the port", () => {
    expect(parsed.imap?.socket).toBe("SSL");
    expect(parsed.smtp?.socket).toBe("SSL");
  });

  it("treats <SSL>on</SSL> on 587 as STARTTLS", () => {
    const xml = FORWARD_EMAIL_AUTODISCOVER.replace("<Port>465</Port>", "<Port>587</Port>");
    expect(parseAutodiscover(xml, "a@b.com", "a").smtp?.socket).toBe("STARTTLS");
  });
});

describe("providerFromMx", () => {
  it("recognises Forward Email", () => {
    expect(providerFromMx(["mx1.forwardemail.net.", "mx2.forwardemail.net."])?.name).toBe(
      "Forward Email",
    );
  });

  it("recognises Google Workspace", () => {
    expect(providerFromMx(["aspmx.l.google.com."])?.name).toBe("Google Workspace / Gmail");
  });

  it("recognises Microsoft 365", () => {
    expect(providerFromMx(["example-com.mail.protection.outlook.com."])?.name).toBe(
      "Microsoft 365 / Outlook",
    );
  });

  it("does not match a lookalike domain", () => {
    expect(providerFromMx(["mx.forwardemail.net.evil.com."])).toBeNull();
    expect(providerFromMx(["notgoogle.com."])).toBeNull();
  });

  it("returns null for an unknown host", () => {
    expect(providerFromMx(["mail.some-tiny-host.co.uk."])).toBeNull();
  });
});

describe("isPrivateAddress", () => {
  it("flags loopback, RFC1918, link-local and CGNAT", () => {
    for (const addr of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(addr), addr).toBe(true);
    }
  });

  it("allows normal public addresses", () => {
    for (const addr of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(addr), addr).toBe(false);
    }
  });
});

describe("passwordNoteFor", () => {
  const base: MailboxDiscovery = {
    email: "a@b.com",
    domain: "b.com",
    source: "mx-provider",
    sourceDetail: "",
    providerName: null,
    imap: null,
    smtp: null,
    confident: true,
    attempts: [],
  };

  it("warns about Gmail app passwords", () => {
    const note = passwordNoteFor({
      ...base,
      smtp: {
        protocol: "smtp",
        host: "smtp.gmail.com",
        port: 465,
        socket: "SSL",
        username: "a@b.com",
      },
    });
    expect(note).toMatch(/App Password/i);
  });

  it("says nothing for a host with no special requirement", () => {
    expect(
      passwordNoteFor({
        ...base,
        smtp: {
          protocol: "smtp",
          host: "smtp.some-tiny-host.co.uk",
          port: 465,
          socket: "SSL",
          username: "a@b.com",
        },
      }),
    ).toBeNull();
  });
});
