// Credit pack catalog. 1 credit = 1 scan.
// Larger packs come with a sliding-scale discount off the $1/credit rack rate.

export type CreditPack = {
  id: string;
  label: string;
  credits: number;
  amountCents: number; // What we actually charge.
  popular?: boolean;
};

export const CREDIT_PACKS: CreditPack[] = [
  { id: "pack-1", label: "Starter", credits: 1, amountCents: 100 }, // $1.00/scan
  { id: "pack-10", label: "10 scans", credits: 10, amountCents: 900 }, // $0.90/scan — 10% off
  { id: "pack-50", label: "50 scans", credits: 50, amountCents: 3750, popular: true }, // $0.75/scan — 25% off
  { id: "pack-100", label: "100 scans", credits: 100, amountCents: 7000 }, // $0.70/scan — 30% off
];

export function findPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  })}`;
}

export function perScanCents(pack: CreditPack): number {
  return Math.round(pack.amountCents / pack.credits);
}

export function discountPct(pack: CreditPack): number {
  const rack = pack.credits * 100;
  if (pack.amountCents >= rack) return 0;
  return Math.round(((rack - pack.amountCents) / rack) * 100);
}
