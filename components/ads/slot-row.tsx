"use client";

import { SlotManager } from "@/components/ads/slot-manager";
import { useListRowHidden } from "@/components/list-filter";

/**
 * One row of the slots list, hidden when the filter excludes it.
 *
 * SlotManager's root element is the `li` the list needs, so it cannot be wrapped
 * in `ListFilterRow` — an `li` inside an `li` is invalid markup. This reads the
 * filter's decision and hands it down as a prop instead. It exists as its own
 * client module because the page around it is a server component and cannot read
 * the filter's context itself.
 */
export function SlotRow({
  rowId,
  ...props
}: { rowId: string } & React.ComponentProps<typeof SlotManager>) {
  const hidden = useListRowHidden(rowId);
  return <SlotManager {...props} hidden={hidden} />;
}
