import { nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

export class SettingsRepository {
  constructor(private readonly db: Database) {}

  get(key: string): string | undefined {
    const row = this.db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', key);
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      nowIso(),
    );
  }

  getBool(key: string, fallback: boolean): boolean {
    const raw = this.get(key);
    if (raw === undefined) return fallback;
    return raw === 'true';
  }

  setBool(key: string, value: boolean): void {
    this.set(key, value ? 'true' : 'false');
  }
}

export const SETTING_KEYS = {
  outreachKillSwitch: 'outreach.kill_switch',
  automationPaused: 'automation.paused',
} as const;
