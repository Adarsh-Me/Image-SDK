import type { ImageCost } from "@image-sdk/core";

export interface BudgetLimit {
  scope: string;
  amount: number;
  currency: string;
}

export interface BudgetReservation {
  id: string;
  scope: string;
  amount: number;
  currency: string;
}

export interface BudgetStore {
  reserve(limit: BudgetLimit, amount: number): Promise<BudgetReservation>;
  commit(reservation: BudgetReservation, cost?: ImageCost): Promise<void>;
  release(reservation: BudgetReservation): Promise<void>;
  summary(scope: string): Promise<{ limit: BudgetLimit; spent: number; reserved: number }>;
}

export class BudgetExceededError extends Error {
  constructor(scope: string) {
    super(`The configured image budget for ${scope} has been exhausted.`);
    this.name = "BudgetExceededError";
  }
}

export function memoryBudgetStore(): BudgetStore {
  const accounts = new Map<string, { limit: BudgetLimit; spent: number; reservations: Map<string, number> }>();
  let sequence = 0;

  function accountFor(limit: BudgetLimit) {
    const normalized = normalizeLimit(limit);
    const current = accounts.get(normalized.scope);
    if (current) {
      if (current.limit.amount !== normalized.amount || current.limit.currency !== normalized.currency) {
        throw new TypeError(`Budget scope ${normalized.scope} was configured with a different limit or currency.`);
      }
      return current;
    }

    const created = { limit: normalized, spent: 0, reservations: new Map<string, number>() };
    accounts.set(normalized.scope, created);
    return created;
  }

  return {
    async reserve(limit, amount): Promise<BudgetReservation> {
      const account = accountFor(limit);
      validateAmount(amount);
      const reserved = sum(account.reservations.values());
      if (account.spent + reserved + amount > account.limit.amount) {
        throw new BudgetExceededError(account.limit.scope);
      }
      const id = `budget_${++sequence}`;
      account.reservations.set(id, amount);
      return { id, scope: account.limit.scope, amount, currency: account.limit.currency };
    },

    async commit(reservation, cost): Promise<void> {
      const account = requireReservation(accounts, reservation);
      const reserved = account.reservations.get(reservation.id)!;
      const actual = cost?.amount ?? reserved;
      validateAmount(actual);
      if (cost && cost.currency !== reservation.currency) {
        throw new TypeError("The provider cost currency does not match the configured budget currency.");
      }
      if (actual > reserved) {
        throw new BudgetExceededError(reservation.scope);
      }
      account.reservations.delete(reservation.id);
      account.spent += actual;
    },

    async release(reservation): Promise<void> {
      requireReservation(accounts, reservation).reservations.delete(reservation.id);
    },

    async summary(scope): Promise<{ limit: BudgetLimit; spent: number; reserved: number }> {
      const account = accounts.get(scope);
      if (!account) {
        throw new TypeError(`No budget exists for scope ${scope}.`);
      }
      return { limit: account.limit, spent: account.spent, reserved: sum(account.reservations.values()) };
    }
  };
}

function normalizeLimit(limit: BudgetLimit): BudgetLimit {
  const scope = limit.scope.trim();
  const currency = limit.currency.trim().toUpperCase();
  if (!scope || !currency) {
    throw new TypeError("Budget limits require non-empty scope and currency values.");
  }
  validateAmount(limit.amount);
  return { scope, currency, amount: limit.amount };
}

function requireReservation(
  accounts: Map<string, { limit: BudgetLimit; spent: number; reservations: Map<string, number> }>,
  reservation: BudgetReservation
) {
  const account = accounts.get(reservation.scope);
  if (!account || account.limit.currency !== reservation.currency || !account.reservations.has(reservation.id)) {
    throw new TypeError("The supplied budget reservation is not active.");
  }
  return account;
}

function validateAmount(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("Budget amounts must be finite non-negative numbers.");
  }
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
