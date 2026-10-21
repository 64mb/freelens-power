import { Common } from "@freelensapp/extensions";
import { action, makeObservable, observable } from "mobx";
import { type DashboardCard, sanitizeDashboardCards } from "../dashboard";

export interface DashboardPreferencesModel {
  cards: DashboardCard[];
}

export class DashboardPreferencesStore extends Common.Store.ExtensionStore<DashboardPreferencesModel> {
  cards: DashboardCard[] = [];

  constructor() {
    super({ configName: "dashboard-preferences", defaults: { cards: [] } });
    makeObservable(this, {
      cards: observable,
      fromStore: action,
      upsertCard: action,
      removeCard: action,
      moveCard: action,
    });
  }

  fromStore(data: Partial<DashboardPreferencesModel>): void {
    this.cards = sanitizeDashboardCards(data?.cards);
  }

  upsertCard(card: DashboardCard): void {
    const normalized = sanitizeDashboardCards([card])[0];
    if (!normalized) return;
    const index = this.cards.findIndex((entry) => entry.id === normalized.id);
    if (index < 0) this.cards.push(normalized);
    else this.cards[index] = normalized;
  }

  removeCard(id: string): void {
    this.cards = this.cards.filter((card) => card.id !== id);
  }

  moveCard(id: string, targetIndex: number): void {
    const index = this.cards.findIndex((card) => card.id === id);
    if (index < 0 || !Number.isFinite(targetIndex)) return;
    const destination = Math.max(0, Math.min(this.cards.length - 1, Math.trunc(targetIndex)));
    if (index === destination) return;
    const [card] = this.cards.splice(index, 1);
    this.cards.splice(destination, 0, card);
  }

  toJSON(): DashboardPreferencesModel {
    return {
      cards: this.cards.map(({ id, title, url, size, autoRefresh }) => ({
        id,
        title,
        url,
        size,
        autoRefresh: autoRefresh === true,
      })),
    };
  }
}
