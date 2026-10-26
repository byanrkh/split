// app/(root)/summary/page.tsx
"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { newsreader } from "@/libs/Fonts";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type Participant = {
  id: string;
  name: string;
};

type BillItem = {
  id: string;
  name: string;
  price: number; // integer, smallest currency unit (IDR has no decimals)
  assigneeIds: string[];
};

type ItemShare = {
  itemId: string;
  name: string;
  amount: number;
  sharedWith: number;
};

type PersonBreakdown = {
  participant: Participant;
  items: ItemShare[];
  subtotal: number;
  taxShare: number;
  total: number;
  groupPercent: number; // this person's share of the group subtotal (0-100)
};

type SplitResult = {
  people: PersonBreakdown[];
  groupSubtotal: number;
  taxTotal: number;
  grandTotal: number;
  allocatedTotal: number;
  unassignedItems: BillItem[];
  isBalanced: boolean;
};

/* -------------------------------------------------------------------------- */
/*  Calculation engine (pure integer math)                                    */
/* -------------------------------------------------------------------------- */

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

/**
 * Splits an integer amount across `count` people. Shares always add up to
 * `amount`. Leftover units are handed out starting at `offset` (rotated per
 * item so no single person always absorbs the extra unit).
 */
function splitEvenly(amount: number, count: number, offset = 0): number[] {
  if (count <= 0) return [];
  const base = Math.floor(amount / count);
  const shares = new Array<number>(count).fill(base);
  const remainder = amount - base * count;
  for (let k = 0; k < remainder; k++) {
    shares[(offset + k) % count] += 1;
  }
  return shares;
}

/**
 * Largest-remainder allocation: distributes `total` proportionally to
 * `weights` using integers only, so the result always sums to `total`.
 *
 * share_i = (weight_i / sum(weights)) * total
 */
function allocateProportionally(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];

  const weightSum = sum(weights);
  if (weightSum <= 0) return splitEvenly(total, weights.length);

  const floors: number[] = [];
  const remainders: number[] = [];

  weights.forEach((weight) => {
    const numerator = total * weight;
    const remainder = numerator % weightSum;
    floors.push((numerator - remainder) / weightSum);
    remainders.push(remainder);
  });

  let leftover = total - sum(floors);
  const order = weights
    .map((_, index) => index)
    .sort((a, b) => remainders[b] - remainders[a] || a - b);

  const result = [...floors];
  for (const index of order) {
    if (leftover <= 0) break;
    result[index] += 1;
    leftover -= 1;
  }

  return result;
}

function computeSplit(
  participants: Participant[],
  items: BillItem[],
  taxTotal: number,
): SplitResult {
  const indexById = new Map<string, number>(
    participants.map((p, i) => [p.id, i] as [string, number]),
  );
  const itemShares: ItemShare[][] = participants.map(() => []);
  const unassignedItems: BillItem[] = [];

  items.forEach((item, itemIndex) => {
    const assigneeIndexes = Array.from(
      new Set(
        item.assigneeIds
          .map((id) => indexById.get(id))
          .filter((index): index is number => index !== undefined),
      ),
    ).sort((a, b) => a - b);

    if (assigneeIndexes.length === 0) {
      unassignedItems.push(item);
      return;
    }

    const shares = splitEvenly(item.price, assigneeIndexes.length, itemIndex);

    assigneeIndexes.forEach((participantIndex, k) => {
      itemShares[participantIndex].push({
        itemId: item.id,
        name: item.name,
        amount: shares[k],
        sharedWith: assigneeIndexes.length,
      });
    });
  });

  const subtotals = itemShares.map((list) => sum(list.map((i) => i.amount)));
  const groupSubtotal = sum(subtotals);
  const taxShares = allocateProportionally(taxTotal, subtotals);

  const people: PersonBreakdown[] = participants.map((participant, i) => ({
    participant,
    items: itemShares[i],
    subtotal: subtotals[i],
    taxShare: taxShares[i],
    total: subtotals[i] + taxShares[i],
    groupPercent: groupSubtotal > 0 ? (subtotals[i] / groupSubtotal) * 100 : 0,
  }));

  const grandTotal = groupSubtotal + taxTotal;
  const allocatedTotal = sum(people.map((p) => p.total));

  return {
    people,
    groupSubtotal,
    taxTotal,
    grandTotal,
    allocatedTotal,
    unassignedItems,
    isBalanced: allocatedTotal === grandTotal,
  };
}

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

function formatIDR(amount: number): string {
  return `Rp ${amount.toLocaleString("id-ID")}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function buildShareText(result: SplitResult): string {
  const lines: string[] = [];

  lines.push("*Split Summary*");
  lines.push(
    `Subtotal ${formatIDR(result.groupSubtotal)} + Tax ${formatIDR(
      result.taxTotal,
    )} = *${formatIDR(result.grandTotal)}*`,
  );

  result.people.forEach((person) => {
    lines.push("");
    lines.push(`*${person.participant.name} — ${formatIDR(person.total)}*`);
    person.items.forEach((item) => {
      const shared = item.sharedWith > 1 ? ` (÷${item.sharedWith})` : "";
      lines.push(`• ${item.name}${shared} — ${formatIDR(item.amount)}`);
    });
    lines.push(
      `Subtotal ${formatIDR(person.subtotal)} + Tax ${formatIDR(
        person.taxShare,
      )}`,
    );
  });

  lines.push("");
  lines.push("Tax is split proportionally to each person's subtotal.");

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Mock data                                                                 */
/* -------------------------------------------------------------------------- */

const MOCK_PARTICIPANTS: Participant[] = [
  { id: "p1", name: "Abyan" },
  { id: "p2", name: "Rara" },
  { id: "p3", name: "Dimas" },
  { id: "p4", name: "Salsa" },
];

const MOCK_ITEMS: BillItem[] = [
  { id: "i1", name: "Nasi Goreng Spesial", price: 38000, assigneeIds: ["p1"] },
  { id: "i2", name: "Mie Ayam Bakso", price: 32000, assigneeIds: ["p2"] },
  { id: "i3", name: "Ayam Bakar Madu", price: 45000, assigneeIds: ["p3"] },
  {
    id: "i4",
    name: "Sate Taichan",
    price: 60000,
    assigneeIds: ["p1", "p2", "p3"],
  },
  {
    id: "i5",
    name: "Tahu Crispy",
    price: 25000,
    assigneeIds: ["p2", "p3", "p4"],
  },
  { id: "i6", name: "Es Teh Manis", price: 8000, assigneeIds: ["p1"] },
  { id: "i7", name: "Es Jeruk", price: 12000, assigneeIds: ["p2"] },
  { id: "i8", name: "Kopi Susu", price: 22000, assigneeIds: ["p3"] },
  { id: "i9", name: "Salad Buah", price: 28000, assigneeIds: ["p4"] },
  { id: "i10", name: "Matcha Latte", price: 30000, assigneeIds: ["p4"] },
];

const MOCK_TAX_TOTAL = 33000;

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function SplitSummaryPage() {
  const [participants] = useState<Participant[]>(MOCK_PARTICIPANTS);
  const [items] = useState<BillItem[]>(MOCK_ITEMS);
  const [taxTotal] = useState<number>(MOCK_TAX_TOTAL);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const result = useMemo(
    () => computeSplit(participants, items, taxTotal),
    [participants, items, taxTotal],
  );

  const shareText = useMemo(() => buildShareText(result), [result]);
  const whatsappHref = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shareText);
    } catch {
      const el = document.createElement("textarea");
      el.value = shareText;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }

    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <main className="flex-1 bg-[#FAFAFA] text-[#1E1E1E]">
      <div className="mx-auto w-full max-w-2xl px-6 pb-24 pt-10 sm:px-8 sm:pt-16">
        {/* Header */}
        <Link
          href="/"
          className="inline-block text-sm text-slate-500 transition-colors hover:text-[#1E1E1E]"
        >
          ← Back
        </Link>

        <header className="mt-12 sm:mt-16">
          <h1
            className={`${newsreader.className} text-4xl font-semibold tracking-tight sm:text-5xl`}
          >
            Split Summary
          </h1>
          <p className="mt-3 max-w-md text-base leading-relaxed text-slate-500">
            Here is the transparent breakdown of what everyone owes.
          </p>
        </header>

        {/* Overview */}
        <section aria-label="Bill overview" className="mt-12">
          <dl className="grid grid-cols-3 gap-4 border-y border-gray-200 py-5">
            <div>
              <dt className="text-xs uppercase tracking-wider text-slate-500">
                Subtotal
              </dt>
              <dd className="mt-1 text-base font-medium tabular-nums sm:text-lg">
                {formatIDR(result.groupSubtotal)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-slate-500">
                Tax
              </dt>
              <dd className="mt-1 text-base font-medium tabular-nums sm:text-lg">
                {formatIDR(result.taxTotal)}
              </dd>
            </div>
            <div className="text-right">
              <dt className="text-xs uppercase tracking-wider text-slate-500">
                Total
              </dt>
              <dd className="mt-1 text-base font-semibold tabular-nums sm:text-lg">
                {formatIDR(result.grandTotal)}
              </dd>
            </div>
          </dl>
        </section>

        {/* Participant breakdown */}
        <section aria-label="Participant breakdown" className="mt-2">
          <ol className="divide-y divide-gray-200 border-b border-gray-200">
            {result.people.map((person) => (
              <li key={person.participant.id} className="py-8">
                <div className="flex items-baseline justify-between gap-4">
                  <h2
                    className={`${newsreader.className} text-2xl font-semibold tracking-tight`}
                  >
                    {person.participant.name}
                  </h2>
                  <p className="text-2xl font-semibold tabular-nums">
                    {formatIDR(person.total)}
                  </p>
                </div>

                {person.items.length > 0 ? (
                  <ul className="mt-5 space-y-2">
                    {person.items.map((item) => (
                      <li
                        key={item.itemId}
                        className="flex items-baseline justify-between gap-4 text-sm"
                      >
                        <span className="text-slate-600">
                          {item.name}
                          {item.sharedWith > 1 && (
                            <span className="ml-2 text-xs text-slate-400">
                              ÷{item.sharedWith}
                            </span>
                          )}
                        </span>
                        <span className="tabular-nums text-slate-600">
                          {formatIDR(item.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-5 text-sm text-slate-400">
                    No items assigned.
                  </p>
                )}

                <dl className="mt-5 space-y-2 border-t border-gray-200 pt-4 text-sm">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-slate-500">Subtotal</dt>
                    <dd className="tabular-nums">
                      {formatIDR(person.subtotal)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-slate-500">
                      Tax
                      <span className="ml-2 text-xs text-slate-400">
                        {formatPercent(person.groupPercent)} of group
                      </span>
                    </dt>
                    <dd className="tabular-nums">
                      {formatIDR(person.taxShare)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        </section>

        {/* Unassigned warning */}
        {result.unassignedItems.length > 0 && (
          <p className="mt-6 border-l-2 border-[#1E1E1E] pl-4 text-sm text-slate-600">
            {result.unassignedItems.length} item
            {result.unassignedItems.length > 1 ? "s are" : " is"} not assigned
            and excluded:{" "}
            {result.unassignedItems.map((item) => item.name).join(", ")}.
          </p>
        )}

        {/* Settlement */}
        <section aria-label="Settlement" className="mt-16">
          <h2
            className={`${newsreader.className} text-2xl font-semibold tracking-tight`}
          >
            Settlement
          </h2>

          <div className="mt-5 flex items-baseline justify-between gap-4">
            <p className="text-sm text-slate-500">Grand total</p>
            <p className="text-3xl font-semibold tabular-nums">
              {formatIDR(result.grandTotal)}
            </p>
          </div>

          <p
            className={`mt-2 text-right text-xs ${
              result.isBalanced ? "text-slate-400" : "text-red-600"
            }`}
          >
            {result.isBalanced
              ? `✓ ${result.people.length} shares add up to ${formatIDR(
                  result.allocatedTotal,
                )}`
              : `Mismatch: shares add up to ${formatIDR(
                  result.allocatedTotal,
                )}`}
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={handleCopy}
              className="w-full rounded-lg bg-[#1E1E1E] px-6 py-3.5 text-sm font-medium text-white transition-colors hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E1E1E] focus-visible:ring-offset-2 sm:w-auto"
            >
              {copied ? "Copied ✓" : "Copy breakdown"}
            </button>

            <a
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full rounded-lg border border-gray-200 bg-white px-6 py-3.5 text-center text-sm font-medium text-[#1E1E1E] transition-colors hover:border-[#1E1E1E] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1E1E1E] focus-visible:ring-offset-2 sm:w-auto"
            >
              Share via WhatsApp
            </a>
          </div>

          <span className="sr-only" role="status" aria-live="polite">
            {copied ? "Breakdown copied to clipboard" : ""}
          </span>
        </section>

        <footer className="mt-20 text-center text-xs text-slate-400">
          Tax is split proportionally to each person&apos;s subtotal.
        </footer>
      </div>
    </main>
  );
}
