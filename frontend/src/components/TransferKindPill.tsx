import { Pill } from "./ui";
import { isDebitCard, isPayout } from "../lib/transferKinds";

/** Marks the transfers that don't move cash the usual way: a payout
 *  (cash out to a recipient) or a debit card send (no cash in). A
 *  plain cash send renders nothing. One pill for the list, the
 *  dashboard and the detail page so the two kinds read the same
 *  everywhere. */
export default function TransferKindPill({
  serviceType, paymentMethod,
}: {
  serviceType: string | null | undefined;
  paymentMethod: string | null | undefined;
}) {
  if (isPayout(serviceType)) return <Pill tone="info">Payout</Pill>;
  if (isDebitCard(paymentMethod)) return <Pill tone="info">Debit card</Pill>;
  return null;
}
