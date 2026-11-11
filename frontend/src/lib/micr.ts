// The MICR line: the magnetic numbers along the bottom of a check.
// The scanner reads it; without one, the cashier types it. Either way
// this one parser turns it into the routing number, the account and the
// check number. Rules: api/Modules/CheckCashing/INVARIANTS.md ("Scanner").
//
// The line has three fields marked by special symbols that a keyboard
// does not have, so each has typed stand-ins:
//   transit ⑆  (typed T, A or :)  — around the 9-digit routing number
//   on-us   ⑈  (typed U, C or ")  — after the account number
//   amount  ⑇  (typed $)          — around the amount (printed after deposit)
//   dash    ⑉  (typed -)          — inside an account; dropped
// A business check carries its number first, between two on-us marks
// ("⑈010232⑈ ⑆111000025⑆ 4400123456⑈"); a personal check after the
// account ("⑆111000025⑆ 4400123456⑈ 0232"). A line typed with spaces
// only ("111000025 4400123456 232") works too.

export interface MicrFields {
  routing: string;
  account: string;
  number: string;
  /** Cents, when the line carries the amount field. */
  amountCents: number | null;
  /** Whether the routing number passes the ABA check digit. */
  routingValid: boolean;
}

/** The ABA check digit: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) is a
 *  multiple of 10. Same rule as the server's ``aba_routing_valid``. */
export function abaRoutingValid(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = [...routing].map(Number);
  const total = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return total % 10 === 0;
}

/** One letter per field mark (T transit, U on-us, $ amount), digits
 *  and spaces; everything else goes. */
function normalize(line: string): string {
  return line
    .replace(/[⑆Aa:Tt]/g, " T ")
    .replace(/[⑈Cc"Uu]/g, " U ")
    .replace(/[⑇$]/g, " $ ")
    .replace(/[⑉-]/g, "")
    .replace(/[^\dTU$ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function groups(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

function checkNumber(digits: string): string {
  return digits.replace(/^0+(?=\d)/, "");
}

/** The fields of a MICR line, or null when no routing number is in it. */
export function parseMicrLine(line: string): MicrFields | null {
  let text = normalize(line);

  let amountCents: number | null = null;
  const amount = text.match(/\$ (\d+) \$/);
  if (amount) {
    amountCents = Number(amount[1]);
    text = text.replace(amount[0], " ");
  }

  let before: string;
  let after: string;
  let routing: string;
  const marked = text.match(/T (\d{9}) T/);
  if (marked && marked.index != null) {
    routing = marked[1];
    before = text.slice(0, marked.index);
    after = text.slice(marked.index + marked[0].length);
  } else {
    // No transit marks: the first group of nine digits that passes the
    // check digit (else the first group of nine) is the routing number.
    const plain = text.replace(/[TU$]/g, " ");
    const nine = groups(plain).filter((g) => g.length === 9);
    const pick = nine.find(abaRoutingValid) ?? nine[0];
    if (!pick) return null;
    routing = pick;
    const at = plain.indexOf(pick);
    before = plain.slice(0, at);
    after = plain.slice(at + pick.length);
  }

  // The business check number sits before the routing number.
  const aux = groups(before).join("");
  let number = aux ? checkNumber(aux) : "";
  let account = "";

  const firstOnUs = after.indexOf("U");
  if (firstOnUs >= 0) {
    const head = groups(after.slice(0, firstOnUs));
    const tail = groups(after.slice(firstOnUs + 1));
    // "1234 4400123456⑈": a short group in front is the check number.
    if (!number && head.length > 1 && head[0].length <= 6) {
      number = checkNumber(head.shift() ?? "");
    }
    account = head.join("");
    if (!number && tail.length) number = checkNumber(tail.join(""));
  } else {
    // No on-us mark: the longer group is the account, a short one the
    // check number.
    const rest = groups(after);
    if (rest.length === 1) {
      account = rest[0];
    } else if (rest.length > 1) {
      const sorted = [...rest].sort((a, b) => b.length - a.length);
      account = sorted[0];
      if (!number) number = checkNumber(sorted[sorted.length - 1]);
    }
  }

  return {
    routing, account: account.slice(0, 20), number: number.slice(0, 20),
    amountCents, routingValid: abaRoutingValid(routing),
  };
}
