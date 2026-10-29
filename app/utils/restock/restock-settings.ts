import type { PlanningSettings } from "./restock.types";

export type SettingsValidation =
  | { valid: true; settings: { leadTimeDays: number; coverageDays: number; safetyBufferDays: number } }
  | { valid: false; message: string };

export function validatePlanningSettings(settings: PlanningSettings): SettingsValidation {
  const fields = [settings.leadTimeDays, settings.coverageDays, settings.safetyBufferDays];
  if (fields.some((value) => value === null)) {
    return { valid: false, message: "Enter lead time, coverage, and safety buffer to calculate purchase quantities." };
  }
  if (fields.some((value) => !Number.isInteger(value) || (value as number) < 0 || (value as number) > 365)) {
    return { valid: false, message: "Each planning value must be a whole number from 0 to 365 days." };
  }
  const [leadTimeDays, coverageDays, safetyBufferDays] = fields as [number, number, number];
  return { valid: true, settings: { leadTimeDays, coverageDays, safetyBufferDays } };
}

export function parseOptionalInteger(value: string): number | null {
  if (value.trim() === "") return null;
  if (!/^\d+$/.test(value.trim())) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 365 ? parsed : Number.NaN;
}
