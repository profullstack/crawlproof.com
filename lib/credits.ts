// Credit pack catalog. 1 credit = 1 scan = $1.
// Add or change packs here; the catalog is the source of truth.

export type CreditPack = {
  id: string;
  label: string;
  credits: number;
  amountCents: number; // USD cents charged at purchase
  popular?: boolean;
};

export const CREDIT_PACKS: CreditPack[] = [
  { id: "pack-1", label: "Starter", credits: 1, amountCents: 100 },
  { id: "pack-10", label: "10 scans", credits: 10, amountCents: 1000 },
  { id: "pack-50", label: "50 scans", credits: 50, amountCents: 5000, popular: true },
  { id: "pack-100", label: "100 scans", credits: 100, amountCents: 10000 },
];

export function findPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0 })}`;
}
