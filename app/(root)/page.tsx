"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangeEvent,
  Dispatch,
  FormEvent,
  ReactNode,
  SetStateAction,
} from "react";
import { newsreader } from "@/libs/Fonts";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type Stage = "home" | "review" | "split" | "summary";
type Source = "scan" | "manual";

type Participant = {
  id: string;
  name: string;
};

type BillItem = {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number; // integer rupiah
  assigneeIds: string[];
};

type ItemShare = {
  itemId: string;
  name: string;
  amount: number; // integer rupiah
  sharedWith: number;
};

type PersonBreakdown = {
  participant: Participant;
  items: ItemShare[];
  subtotal: number;
  taxShare: number;
  total: number;
  groupPercent: number;
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
/*  Calculation engine (integer rupiah only)                                  */
/* -------------------------------------------------------------------------- */

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function lineTotal(item: BillItem): number {
  return item.quantity * item.unitPrice;
}

/** Tax in rupiah from a percent rate (supports up to 2 decimals, e.g. 7.25). */
function calcTax(subtotal: number, ratePercent: number): number {
  return Math.round((subtotal * Math.round(ratePercent * 100)) / 10000);
}

/**
 * Splits an integer amount across `count` people. Shares always add up to
 * `amount`. Leftover rupiah are handed out starting at `offset` (rotated per
 * item so no single person always absorbs the extra rupiah).
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

    const shares = splitEvenly(
      lineTotal(item),
      assigneeIndexes.length,
      itemIndex,
    );
    const label =
      item.quantity > 1 ? `${item.quantity}× ${item.name}` : item.name;

    assigneeIndexes.forEach((participantIndex, k) => {
      itemShares[participantIndex].push({
        itemId: item.id,
        name: label,
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
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const moneyFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

function formatMoney(rupiah: number): string {
  return moneyFormatter.format(rupiah);
}

/** Formats typed digits with Indonesian thousand separators: 12000 -> 12.000 */
function formatRupiahInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "").slice(0, 12);
  if (!digits) return "";
  return Number(digits).toLocaleString("id-ID");
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function parseRupiah(raw: string): number | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return value > 0 ? value : null;
}

function parseRate(raw: string): number {
  const value = parseFloat(raw.replace(",", "."));
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

let idCounter = 0;
function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function buildShareText(result: SplitResult, ratePercent: number): string {
  const lines: string[] = [];

  lines.push("*Split Summary*");
  lines.push(
    `Subtotal ${formatMoney(result.groupSubtotal)} + Tax (${ratePercent}%) ${formatMoney(
      result.taxTotal,
    )} = *${formatMoney(result.grandTotal)}*`,
  );

  result.people.forEach((person) => {
    lines.push("");
    lines.push(`*${person.participant.name} — ${formatMoney(person.total)}*`);
    person.items.forEach((item) => {
      const shared = item.sharedWith > 1 ? ` (÷${item.sharedWith})` : "";
      lines.push(`• ${item.name}${shared} — ${formatMoney(item.amount)}`);
    });
    lines.push(
      `Subtotal ${formatMoney(person.subtotal)} + Tax ${formatMoney(
        person.taxShare,
      )}`,
    );
  });

  lines.push("");
  lines.push("Tax is split proportionally to each person's subtotal.");

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Mock data (used by photo upload until OCR is wired up)                    */
/* -------------------------------------------------------------------------- */

function createMockReceipt(): BillItem[] {
  return [
    {
      id: "mock-1",
      name: "Margherita pizza",
      quantity: 1,
      unitPrice: 48000,
      assigneeIds: [],
    },
    {
      id: "mock-2",
      name: "Mushroom pasta",
      quantity: 1,
      unitPrice: 52000,
      assigneeIds: [],
    },
    {
      id: "mock-3",
      name: "Iced tea",
      quantity: 1,
      unitPrice: 12000,
      assigneeIds: [],
    },
    {
      id: "mock-4",
      name: "Lemonade",
      quantity: 1,
      unitPrice: 18000,
      assigneeIds: [],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Shared styles                                                             */
/* -------------------------------------------------------------------------- */

const SHARE_COLORS = [
  "#111827",
  "#64748B",
  "#CBD5E1",
  "#334155",
  "#94A3B8",
  "#475569",
];

const inputClass =
  "h-11 w-full rounded-lg border border-slate-200 bg-white px-3.5 text-[15px] text-[#111827] placeholder:text-slate-400 transition-colors focus:border-[#111827] focus:outline-none";

const labelClass = "mb-1.5 block text-[13px] text-slate-500";

const linkButtonClass =
  "text-[13px] text-[#111827] underline underline-offset-4 transition-colors hover:text-slate-500 focus:outline-none focus-visible:text-slate-500";

const secondaryButtonClass =
  "h-11 rounded-lg border border-slate-200 bg-white px-5 text-sm font-medium text-[#111827] transition-colors hover:border-[#111827] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#111827] focus-visible:ring-offset-2";

/* -------------------------------------------------------------------------- */
/*  Icons                                                                     */
/* -------------------------------------------------------------------------- */

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

function ChevronLeft() {
  return (
    <Icon size={14}>
      <path d="m15 6-6 6 6 6" />
    </Icon>
  );
}

function ChevronRight() {
  return (
    <Icon>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

function ArrowRight() {
  return (
    <Icon>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </Icon>
  );
}

function Close() {
  return (
    <Icon size={14}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </Icon>
  );
}

function Pencil() {
  return (
    <Icon size={14}>
      <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="m13.5 6.5 3 3" />
    </Icon>
  );
}

/* -------------------------------------------------------------------------- */
/*  Receipt primitives (dashed rules, dotted leaders, torn paper)             */
/* -------------------------------------------------------------------------- */

function DashedRule({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`h-px w-full ${className}`}
      style={{
        backgroundImage:
          "repeating-linear-gradient(90deg, #CBD5E1 0, #CBD5E1 5px, transparent 5px, transparent 10px)",
      }}
    />
  );
}

function DoubleRule({ className = "" }: { className?: string }) {
  return (
    <div className={`space-y-[3px] ${className}`}>
      <DashedRule />
      <DashedRule />
    </div>
  );
}

function TornEdge({ position }: { position: "top" | "bottom" }) {
  const id = `torn-${position}`;
  const path =
    position === "bottom" ? "M0 0 L7 7 L14 0 Z" : "M0 7 L7 0 L14 7 Z";

  return (
    <svg
      aria-hidden="true"
      width="100%"
      height="7"
      className={`block text-[#F7F7F5] ${position === "top" ? "-mb-px" : "-mt-px"}`}
    >
      <defs>
        <pattern id={id} width="14" height="7" patternUnits="userSpaceOnUse">
          <path d={path} fill="currentColor" />
        </pattern>
      </defs>
      <rect width="100%" height="7" fill={`url(#${id})`} />
    </svg>
  );
}

function Slip({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <TornEdge position="top" />
      <div className="bg-[#F7F7F5] px-5 py-6">{children}</div>
      <TornEdge position="bottom" />
    </div>
  );
}

function LeaderRow({
  label,
  value,
  trailing,
  className = "text-sm",
  labelClassName = "text-slate-500",
  valueClassName = "text-slate-700",
}: {
  label: ReactNode;
  value: ReactNode;
  trailing?: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
}) {
  return (
    <div className={`flex items-baseline gap-2 ${className}`}>
      <span className={`min-w-0 ${labelClassName}`}>{label}</span>
      <span
        aria-hidden="true"
        className="mb-[5px] min-w-3 flex-1 self-end border-b border-dotted border-slate-300"
      />
      <span className={`shrink-0 tabular-nums ${valueClassName}`}>{value}</span>
      {trailing && <span className="shrink-0 self-center">{trailing}</span>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shared UI                                                                 */
/* -------------------------------------------------------------------------- */

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 self-start text-[13px] text-slate-500 transition-colors hover:text-[#111827] focus:outline-none focus-visible:text-[#111827]"
    >
      <ChevronLeft />
      {label}
    </button>
  );
}

function PageHeader({
  title,
  description,
}: {
  title: ReactNode;
  description: string;
}) {
  return (
    <header className="mt-10">
      <h1
        className={`${newsreader.className} text-[40px] font-medium leading-[1.08] tracking-tight text-[#111827]`}
      >
        {title}
      </h1>
      <p className="mt-4 max-w-sm text-sm leading-relaxed text-slate-500">
        {description}
      </p>
    </header>
  );
}

function SectionHeader({
  label,
  action,
}: {
  label: string;
  action?: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between pb-3 text-[13px]">
        <span className="text-slate-500">{label}</span>
        {action}
      </div>
      <DashedRule />
    </div>
  );
}

function BottomAction({
  hint,
  children,
}: {
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-auto pt-14">
      {hint && (
        <p className="mb-4 text-center text-[13px] text-slate-500">{hint}</p>
      )}
      {children}
    </div>
  );
}

function PrimaryButton({
  onClick,
  disabled = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#111827] px-6 text-sm font-medium text-white transition-colors hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-[#111827] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:hover:bg-slate-300"
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Stage: Home                                                               */
/* -------------------------------------------------------------------------- */

function HomeView({
  scanning,
  scanError,
  onScanFile,
  onManual,
}: {
  scanning: boolean;
  scanError: string;
  onScanFile: (file: File) => void;
  onManual: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onScanFile(file);
  }

  return (
    <div className="pt-12">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      <nav className="flex flex-col gap-12">
        <button
          type="button"
          disabled={scanning}
          onClick={() => fileInputRef.current?.click()}
          className="group flex items-center justify-between gap-4 text-left focus:outline-none disabled:cursor-wait"
        >
          <div className="flex flex-col gap-1">
            <h2
              className={`${newsreader.className} text-xl font-semibold tracking-tight text-[#111827]`}
            >
              Scan Receipt
            </h2>
            <p
              className={`text-sm text-slate-500 ${scanning ? "animate-pulse" : ""}`}
            >
              {scanning
                ? "Reading your receipt…"
                : "Auto-detect items & prices"}
            </p>
          </div>
          <span className="text-slate-400 transition-transform duration-200 group-hover:translate-x-1 group-hover:text-[#111827] group-focus-visible:translate-x-1 group-focus-visible:text-[#111827]">
            <ChevronRight />
          </span>
        </button>

        <button
          type="button"
          disabled={scanning}
          onClick={onManual}
          className="group flex items-center justify-between gap-4 text-left focus:outline-none disabled:opacity-50"
        >
          <div className="flex flex-col gap-1">
            <h2
              className={`${newsreader.className} text-xl font-semibold tracking-tight text-[#111827]`}
            >
              Enter Manually
            </h2>
            <p className="text-sm text-slate-500">Add items one by one</p>
          </div>
          <span className="text-slate-400 transition-transform duration-200 group-hover:translate-x-1 group-hover:text-[#111827] group-focus-visible:translate-x-1 group-focus-visible:text-[#111827]">
            <ChevronRight />
          </span>
        </button>
      </nav>

      {scanError && (
        <p role="alert" className="mt-8 text-[13px] text-red-600">
          {scanError}
        </p>
      )}

      <footer className="mt-16 text-center text-xs text-slate-400">
        © 2026 SplitBill. All rights reserved.
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Stage: Receipt summary (shared by scan + manual)                          */
/* -------------------------------------------------------------------------- */

function ReviewView({
  items,
  setItems,
  taxRateInput,
  setTaxRateInput,
  taxRate,
  subtotal,
  taxTotal,
  total,
  source,
  fileName,
  billDate,
  onBack,
  onContinue,
}: {
  items: BillItem[];
  setItems: Dispatch<SetStateAction<BillItem[]>>;
  taxRateInput: string;
  setTaxRateInput: Dispatch<SetStateAction<string>>;
  taxRate: number;
  subtotal: number;
  taxTotal: number;
  total: number;
  source: Source;
  fileName: string | null;
  billDate: string;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [editMode, setEditMode] = useState(source === "manual");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const showForm = editMode || items.length === 0;

  function resetForm() {
    setEditingId(null);
    setName("");
    setQuantity("1");
    setPrice("");
    setError("");
  }

  function toggleEditMode() {
    if (editMode) resetForm();
    setEditMode(!editMode);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedName = name.trim();
    const qty = Number(quantity);
    const amount = parseRupiah(price);

    if (!trimmedName) {
      setError("Enter an item name.");
      return;
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      setError("Quantity must be a whole number from 1 to 99.");
      return;
    }
    if (amount === null) {
      setError("Enter a valid price, for example 25.000.");
      return;
    }

    if (editingId) {
      setItems((prev) =>
        prev.map((item) =>
          item.id === editingId
            ? { ...item, name: trimmedName, quantity: qty, unitPrice: amount }
            : item,
        ),
      );
    } else {
      setItems((prev) => [
        ...prev,
        {
          id: uid("item"),
          name: trimmedName,
          quantity: qty,
          unitPrice: amount,
          assigneeIds: [],
        },
      ]);
    }

    resetForm();
    nameRef.current?.focus();
  }

  function handleEdit(item: BillItem) {
    setEditingId(item.id);
    setName(item.name);
    setQuantity(String(item.quantity));
    setPrice(formatRupiahInput(String(item.unitPrice)));
    setError("");
    nameRef.current?.focus();
  }

  function handleRemove(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
    if (editingId === id) resetForm();
  }

  function handleTaxChange(value: string) {
    if (/^\d{0,3}([.,]\d{0,2})?$/.test(value)) setTaxRateInput(value);
  }

  const description =
    source === "scan"
      ? "Here’s what we found. Review the items before splitting the bill."
      : "Add your items below. Review them before splitting the bill.";

  const caption =
    source === "scan"
      ? `Scanned from ${fileName ?? "photo"}`
      : "Entered manually";

  const taxLabel = editMode ? (
    <span className="inline-flex items-center gap-1.5">
      Tax
      <input
        value={taxRateInput}
        onChange={(e) => handleTaxChange(e.target.value)}
        inputMode="decimal"
        autoComplete="off"
        aria-label="Tax rate in percent"
        className="h-7 w-14 rounded-md border border-slate-200 bg-white px-1 text-center text-[13px] tabular-nums text-[#111827] focus:border-[#111827] focus:outline-none"
      />
      %
    </span>
  ) : (
    `Tax (${taxRate}%)`
  );

  return (
    <>
      <BackLink label="Home" onClick={onBack} />

      <PageHeader
        title={
          <>
            Your receipt,
            <br />
            simplified.
          </>
        }
        description={description}
      />

      <Slip className="mt-10">
        <div className="flex items-center justify-between gap-4 text-xs text-slate-500">
          <span className="min-w-0 truncate">{caption}</span>
          <span className="shrink-0 tabular-nums">{billDate}</span>
        </div>

        <DashedRule className="mt-4" />

        <div className="mt-4 flex items-center justify-between text-[13px]">
          <span className="text-slate-500">Your items ({items.length})</span>
          {items.length > 0 && (
            <button
              type="button"
              onClick={toggleEditMode}
              className={linkButtonClass}
            >
              {editMode ? "Done" : "Edit items"}
            </button>
          )}
        </div>

        {items.length > 0 && (
          <ul className="mt-4 space-y-3">
            {items.map((item) => (
              <li key={item.id}>
                <LeaderRow
                  className="text-[15px]"
                  labelClassName="text-[#111827]"
                  valueClassName="text-[#111827]"
                  label={
                    <>
                      <span className="mr-2 inline-block min-w-5 text-[13px] tabular-nums text-slate-400">
                        {item.quantity}×
                      </span>
                      {item.name}
                    </>
                  }
                  value={formatMoney(lineTotal(item))}
                  trailing={
                    editMode ? (
                      <span className="ml-1 flex items-center">
                        <button
                          type="button"
                          onClick={() => handleEdit(item)}
                          aria-label={`Edit ${item.name}`}
                          className="rounded p-1.5 text-slate-400 transition-colors hover:text-[#111827]"
                        >
                          <Pencil />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemove(item.id)}
                          aria-label={`Remove ${item.name}`}
                          className="rounded p-1.5 text-slate-400 transition-colors hover:text-red-600"
                        >
                          <Close />
                        </button>
                      </span>
                    ) : undefined
                  }
                />
              </li>
            ))}
          </ul>
        )}

        {showForm && (
          <form
            onSubmit={handleSubmit}
            noValidate
            className="mt-5 rounded-lg border border-dashed border-slate-300 bg-white/70 p-4"
          >
            <div className="space-y-3">
              <div>
                <label htmlFor="item-name" className={labelClass}>
                  {editingId ? "Edit item" : "Item name"}
                </label>
                <input
                  id="item-name"
                  ref={nameRef}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Margherita pizza"
                  autoComplete="off"
                  className={inputClass}
                />
              </div>

              <div className="grid grid-cols-[72px_1fr] gap-3">
                <div>
                  <label htmlFor="item-qty" className={labelClass}>
                    Qty
                  </label>
                  <input
                    id="item-qty"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    inputMode="numeric"
                    autoComplete="off"
                    className={`${inputClass} text-center tabular-nums`}
                  />
                </div>
                <div>
                  <label htmlFor="item-price" className={labelClass}>
                    Unit price
                  </label>
                  <div className="relative">
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px] text-slate-400"
                    >
                      Rp
                    </span>
                    <input
                      id="item-price"
                      value={price}
                      onChange={(e) =>
                        setPrice(formatRupiahInput(e.target.value))
                      }
                      inputMode="numeric"
                      placeholder="0"
                      autoComplete="off"
                      className={`${inputClass} pl-10 tabular-nums`}
                    />
                  </div>
                </div>
              </div>
            </div>

            {error && (
              <p role="alert" className="mt-3 text-[13px] text-red-600">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-3">
              <button
                type="submit"
                className="h-11 flex-1 rounded-lg bg-[#111827] px-5 text-sm font-medium text-white transition-colors hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-[#111827] focus-visible:ring-offset-2"
              >
                {editingId ? "Save item" : "Add item"}
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="h-11 px-3 text-sm text-slate-500 transition-colors hover:text-[#111827]"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}

        <DashedRule className="mt-6" />

        <div className="mt-4 space-y-2">
          <LeaderRow label="Subtotal" value={formatMoney(subtotal)} />
          <LeaderRow label={taxLabel} value={formatMoney(taxTotal)} />
        </div>

        <DoubleRule className="mt-4" />

        <div className="mt-4 flex items-baseline justify-between gap-4">
          <span
            className={`${newsreader.className} text-[22px] font-medium text-[#111827]`}
          >
            Total
          </span>
          <span
            className={`${newsreader.className} text-[34px] font-medium tabular-nums text-[#111827]`}
          >
            {formatMoney(total)}
          </span>
        </div>
      </Slip>

      <BottomAction
        hint={
          items.length === 0
            ? "Add at least one item to continue."
            : "Next, choose who’s sharing the bill."
        }
      >
        <PrimaryButton onClick={onContinue} disabled={items.length === 0}>
          Continue to split
          <ArrowRight />
        </PrimaryButton>
      </BottomAction>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Stage: Split (participants + assignment)                                  */
/* -------------------------------------------------------------------------- */

function SplitView({
  participants,
  setParticipants,
  items,
  setItems,
  onBack,
  onContinue,
}: {
  participants: Participant[];
  setParticipants: Dispatch<SetStateAction<Participant[]>>;
  items: BillItem[];
  setItems: Dispatch<SetStateAction<BillItem[]>>;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [nameInput, setNameInput] = useState("");
  const [error, setError] = useState("");

  const unassignedCount = items.filter(
    (item) =>
      !item.assigneeIds.some((id) => participants.some((p) => p.id === id)),
  ).length;
  const canContinue = participants.length > 0 && unassignedCount === 0;

  const hint =
    participants.length === 0
      ? "Add at least one person to continue."
      : unassignedCount > 0
        ? `${unassignedCount} ${unassignedCount > 1 ? "items still need" : "item still needs"} someone.`
        : "Next, see what everyone owes.";

  function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = nameInput.trim();
    if (!trimmed) return;

    const exists = participants.some(
      (p) => p.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) {
      setError(`${trimmed} is already added.`);
      return;
    }

    setParticipants((prev) => [...prev, { id: uid("p"), name: trimmed }]);
    setNameInput("");
    setError("");
  }

  function handleRemove(id: string) {
    setParticipants((prev) => prev.filter((p) => p.id !== id));
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        assigneeIds: item.assigneeIds.filter((assigneeId) => assigneeId !== id),
      })),
    );
  }

  function toggleAssignee(itemId: string, participantId: string) {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;
        const assigned = item.assigneeIds.includes(participantId);
        return {
          ...item,
          assigneeIds: assigned
            ? item.assigneeIds.filter((id) => id !== participantId)
            : [...item.assigneeIds, participantId],
        };
      }),
    );
  }

  function splitAllEqually() {
    const everyone = participants.map((p) => p.id);
    setItems((prev) =>
      prev.map((item) => ({ ...item, assigneeIds: everyone })),
    );
  }

  return (
    <>
      <BackLink label="Receipt" onClick={onBack} />

      <PageHeader
        title={
          <>
            Who’s sharing
            <br />
            the bill?
          </>
        }
        description="Add everyone at the table, then tap names to assign each item. Shared items are split equally."
      />

      <section aria-label="People" className="mt-10">
        <SectionHeader label={`People (${participants.length})`} />

        <form onSubmit={handleAdd} className="mt-4 flex gap-3">
          <input
            value={nameInput}
            onChange={(e) => {
              setNameInput(e.target.value);
              if (error) setError("");
            }}
            placeholder="Name"
            aria-label="Person name"
            autoComplete="off"
            className={inputClass}
          />
          <button type="submit" className={secondaryButtonClass}>
            Add
          </button>
        </form>

        {error && (
          <p role="alert" className="mt-3 text-[13px] text-red-600">
            {error}
          </p>
        )}

        {participants.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-2">
            {participants.map((person) => (
              <li
                key={person.id}
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 py-1.5 pl-3.5 pr-2 text-sm text-[#111827]"
              >
                {person.name}
                <button
                  type="button"
                  onClick={() => handleRemove(person.id)}
                  aria-label={`Remove ${person.name}`}
                  className="rounded-full p-1 text-slate-400 transition-colors hover:text-[#111827]"
                >
                  <Close />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Assign items" className="mt-12">
        <SectionHeader
          label="Assign items"
          action={
            participants.length > 0 ? (
              <button
                type="button"
                onClick={splitAllEqually}
                className={linkButtonClass}
              >
                Split all equally
              </button>
            ) : undefined
          }
        />

        <ul>
          {items.map((item) => {
            const assignedCount = item.assigneeIds.filter((id) =>
              participants.some((p) => p.id === id),
            ).length;

            return (
              <li key={item.id}>
                <div className="py-5">
                  <LeaderRow
                    className="text-[15px]"
                    labelClassName="text-[#111827]"
                    valueClassName="text-[#111827]"
                    label={
                      <>
                        {item.quantity > 1 && (
                          <span className="mr-2 text-[13px] tabular-nums text-slate-400">
                            {item.quantity}×
                          </span>
                        )}
                        {item.name}
                      </>
                    }
                    value={
                      <>
                        {formatMoney(lineTotal(item))}
                        {assignedCount > 1 && (
                          <span className="ml-2 text-xs text-slate-400">
                            ÷{assignedCount}
                          </span>
                        )}
                      </>
                    }
                  />

                  {participants.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {participants.map((person) => {
                        const selected = item.assigneeIds.includes(person.id);
                        return (
                          <button
                            key={person.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => toggleAssignee(item.id, person.id)}
                            className={`rounded-full border px-3.5 py-1.5 text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#111827] focus-visible:ring-offset-2 ${
                              selected
                                ? "border-[#111827] bg-[#111827] text-white"
                                : "border-slate-200 text-slate-600 hover:border-slate-400"
                            }`}
                          >
                            {person.name}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="mt-2 text-[13px] text-slate-400">
                      Add people to start assigning.
                    </p>
                  )}
                </div>
                <DashedRule />
              </li>
            );
          })}
        </ul>
      </section>

      <BottomAction hint={hint}>
        <PrimaryButton onClick={onContinue} disabled={!canContinue}>
          See summary
          <ArrowRight />
        </PrimaryButton>
      </BottomAction>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Stage: Split summary (one long receipt)                                   */
/* -------------------------------------------------------------------------- */

function SummaryView({
  result,
  taxRate,
  billDate,
  onBack,
  onReset,
}: {
  result: SplitResult;
  taxRate: number;
  billDate: string;
  onBack: () => void;
  onReset: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shareText = useMemo(
    () => buildShareText(result, taxRate),
    [result, taxRate],
  );
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

  const peopleCount = result.people.length;
  const colorFor = (index: number) => SHARE_COLORS[index % SHARE_COLORS.length];
  const shareOfTotal = (amount: number) =>
    result.grandTotal > 0 ? (amount / result.grandTotal) * 100 : 0;

  return (
    <>
      <BackLink label="Split" onClick={onBack} />

      <PageHeader
        title="Split Summary"
        description="Here is the transparent breakdown of what everyone owes."
      />

      <Slip className="mt-10">
        <div className="flex items-center justify-between gap-4 text-xs text-slate-500">
          <span>
            Split between {peopleCount}{" "}
            {peopleCount === 1 ? "person" : "people"}
          </span>
          <span className="shrink-0 tabular-nums">{billDate}</span>
        </div>

        {/* Share bar */}
        <div
          role="img"
          aria-label={result.people
            .map(
              (p) =>
                `${p.participant.name} ${formatPercent(shareOfTotal(p.total))}`,
            )
            .join(", ")}
          className="mt-5 flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
        >
          {result.people.map((person, index) =>
            person.total > 0 ? (
              <div
                key={person.participant.id}
                style={{
                  width: `${shareOfTotal(person.total)}%`,
                  backgroundColor: colorFor(index),
                }}
              />
            ) : null,
          )}
        </div>

        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-500">
          {result.people.map((person, index) => (
            <li
              key={person.participant.id}
              className="inline-flex items-center gap-1.5"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: colorFor(index) }}
              />
              {person.participant.name}
              <span className="tabular-nums text-slate-400">
                {formatPercent(shareOfTotal(person.total))}
              </span>
            </li>
          ))}
        </ul>

        <DashedRule className="mt-6" />

        {/* Per-person blocks */}
        <ol>
          {result.people.map((person, index) => (
            <li key={person.participant.id}>
              <div className="py-6">
                <div className="flex items-baseline justify-between gap-4">
                  <h2
                    className={`${newsreader.className} flex items-center gap-2.5 text-xl font-semibold tracking-tight text-[#111827]`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: colorFor(index) }}
                    />
                    {person.participant.name}
                  </h2>
                  <p
                    className={`${newsreader.className} text-xl font-semibold tabular-nums text-[#111827]`}
                  >
                    {formatMoney(person.total)}
                  </p>
                </div>

                {person.items.length > 0 ? (
                  <ul className="mt-4 space-y-1.5">
                    {person.items.map((item) => (
                      <li key={item.itemId}>
                        <LeaderRow
                          labelClassName="text-slate-600"
                          valueClassName="text-slate-600"
                          label={
                            <>
                              {item.name}
                              {item.sharedWith > 1 && (
                                <span className="ml-2 text-xs text-slate-400">
                                  ÷{item.sharedWith}
                                </span>
                              )}
                            </>
                          }
                          value={formatMoney(item.amount)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-4 text-sm text-slate-400">
                    No items assigned.
                  </p>
                )}

                <div className="mt-4 space-y-1.5 border-t border-dotted border-slate-300 pt-3">
                  <LeaderRow
                    label="Subtotal"
                    value={formatMoney(person.subtotal)}
                  />
                  <LeaderRow
                    label={
                      <>
                        Tax
                        <span className="ml-2 text-xs text-slate-400">
                          {formatPercent(person.groupPercent)} of{" "}
                          {formatMoney(result.taxTotal)}
                        </span>
                      </>
                    }
                    value={formatMoney(person.taxShare)}
                  />
                </div>
              </div>
              <DashedRule />
            </li>
          ))}
        </ol>

        {result.unassignedItems.length > 0 && (
          <p className="mt-5 border-l-2 border-[#111827] pl-4 text-sm text-slate-600">
            {result.unassignedItems.length} item
            {result.unassignedItems.length > 1 ? "s are" : " is"} not assigned
            and excluded:{" "}
            {result.unassignedItems.map((item) => item.name).join(", ")}.
          </p>
        )}

        {/* Bill totals */}
        <div className="mt-6 space-y-2">
          <LeaderRow
            label="Subtotal"
            value={formatMoney(result.groupSubtotal)}
          />
          <LeaderRow
            label={`Tax (${taxRate}%)`}
            value={formatMoney(result.taxTotal)}
          />
        </div>

        <DoubleRule className="mt-4" />

        <div className="mt-4 flex items-baseline justify-between gap-4">
          <span
            className={`${newsreader.className} text-[22px] font-medium text-[#111827]`}
          >
            Total
          </span>
          <span
            className={`${newsreader.className} text-[34px] font-medium tabular-nums text-[#111827]`}
          >
            {formatMoney(result.grandTotal)}
          </span>
        </div>

        <p
          className={`mt-3 text-right text-xs ${
            result.isBalanced ? "text-slate-400" : "text-red-600"
          }`}
        >
          {result.isBalanced
            ? `✓ ${peopleCount} shares add up to ${formatMoney(
                result.allocatedTotal,
              )}`
            : `Mismatch: shares add up to ${formatMoney(result.allocatedTotal)}`}
        </p>
      </Slip>

      <BottomAction>
        <div className="flex flex-col gap-3">
          <PrimaryButton onClick={handleCopy}>
            {copied ? "Copied ✓" : "Copy breakdown"}
          </PrimaryButton>

          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-12 w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-6 text-sm font-medium text-[#111827] transition-colors hover:border-[#111827] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#111827] focus-visible:ring-offset-2"
          >
            Share via WhatsApp
          </a>

          <button
            type="button"
            onClick={onReset}
            className="mt-2 self-center text-[13px] text-slate-500 underline underline-offset-4 transition-colors hover:text-[#111827]"
          >
            Start a new bill
          </button>
        </div>

        <span className="sr-only" role="status" aria-live="polite">
          {copied ? "Breakdown copied to clipboard" : ""}
        </span>

        <p className="mt-10 text-center text-xs text-slate-400">
          Tax is split proportionally to each person&apos;s subtotal.
        </p>
      </BottomAction>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page (single-page flow, no extra routes)                                  */
/* -------------------------------------------------------------------------- */

export default function Page() {
  const [stage, setStage] = useState<Stage>("home");
  const [source, setSource] = useState<Source>("manual");
  const [scanFileName, setScanFileName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [billDate, setBillDate] = useState("");
  const [items, setItems] = useState<BillItem[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [taxRateInput, setTaxRateInput] = useState("10");
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const taxRate = parseRate(taxRateInput);
  const subtotal = useMemo(() => sum(items.map(lineTotal)), [items]);
  const taxTotal = calcTax(subtotal, taxRate);
  const total = subtotal + taxTotal;

  const result = useMemo(
    () => computeSplit(participants, items, taxTotal),
    [participants, items, taxTotal],
  );

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [stage]);

  useEffect(() => {
    return () => {
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    };
  }, []);

  function handleScanFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setScanError("Choose an image file (JPG, PNG, or HEIC).");
      return;
    }

    setScanError("");
    setScanning(true);

    // Detection is mocked until a real OCR service is connected.
    scanTimerRef.current = setTimeout(() => {
      setItems(createMockReceipt());
      setTaxRateInput("10");
      setSource("scan");
      setScanFileName(file.name);
      setBillDate(todayLabel());
      setScanning(false);
      setStage("review");
    }, 1400);
  }

  function handleManual() {
    if (source !== "manual") setItems([]);
    setSource("manual");
    setScanFileName(null);
    setScanError("");
    setBillDate(todayLabel());
    setStage("review");
  }

  function handleReset() {
    setItems([]);
    setParticipants([]);
    setTaxRateInput("10");
    setSource("manual");
    setScanFileName(null);
    setStage("home");
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col bg-white px-6 pb-10 pt-16 text-[#111827] sm:px-10">
      {stage === "home" && (
        <HomeView
          scanning={scanning}
          scanError={scanError}
          onScanFile={handleScanFile}
          onManual={handleManual}
        />
      )}

      {stage === "review" && (
        <ReviewView
          items={items}
          setItems={setItems}
          taxRateInput={taxRateInput}
          setTaxRateInput={setTaxRateInput}
          taxRate={taxRate}
          subtotal={subtotal}
          taxTotal={taxTotal}
          total={total}
          source={source}
          fileName={scanFileName}
          billDate={billDate}
          onBack={() => setStage("home")}
          onContinue={() => setStage("split")}
        />
      )}

      {stage === "split" && (
        <SplitView
          participants={participants}
          setParticipants={setParticipants}
          items={items}
          setItems={setItems}
          onBack={() => setStage("review")}
          onContinue={() => setStage("summary")}
        />
      )}

      {stage === "summary" && (
        <SummaryView
          result={result}
          taxRate={taxRate}
          billDate={billDate}
          onBack={() => setStage("split")}
          onReset={handleReset}
        />
      )}
    </main>
  );
}
