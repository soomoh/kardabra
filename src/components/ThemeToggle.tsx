import { useEffect, useRef, useState } from 'react';
import { getSetting, putSetting } from '../db/db';
import { useDb, useReportError } from '../db/DbProvider';
import {
  parseThemeChoice,
  THEME_SETTING_KEY,
  type ThemeChoice,
} from '../lib/theme';
import { HalfDiscIcon, MoonIcon, SunIcon } from './icons';

const OPTIONS = [
  { value: 'system', label: 'Match system', Icon: HalfDiscIcon },
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
] as const;

/** System / Light / Dark as three icon radios: native arrow-key handling
 * and radio semantics, no ARIA re-implementation. */
export function ThemeToggle({
  choice,
  onChange,
}: {
  choice: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
}) {
  return (
    <fieldset className="theme-toggle">
      <legend className="visually-hidden">Theme</legend>
      {OPTIONS.map(({ value, label, Icon }) => (
        <label key={value} title={label}>
          <input
            type="radio"
            name="theme"
            className="visually-hidden"
            value={value}
            checked={choice === value}
            onChange={() => onChange(value)}
          />
          <Icon />
          <span className="visually-hidden">{label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Keeps the choice in the settings store. Once the database opens, the
 * stored choice is offered to `onLoad` (it wins over the localStorage
 * mirror, which may have been cleared — unless the user already picked
 * one, which `onLoad` decides). From then on, any choice that differs
 * from what's stored is saved, including the mirror's when the store is
 * empty. Renders nothing. */
export function ThemeSettingSync({
  choice,
  onLoad,
}: {
  choice: ThemeChoice;
  onLoad: (stored: ThemeChoice) => void;
}) {
  const db = useDb();
  const reportError = useReportError();
  const [loaded, setLoaded] = useState(false);
  const stored = useRef<ThemeChoice | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getSetting(db, THEME_SETTING_KEY).then((value) => {
      if (cancelled) return;
      if (value !== undefined) {
        stored.current = parseThemeChoice(value);
        onLoad(stored.current);
      }
      setLoaded(true);
    }, reportError);
    return () => {
      cancelled = true;
    };
  }, [db, onLoad, reportError]);

  useEffect(() => {
    if (!loaded || choice === stored.current) return;
    stored.current = choice;
    putSetting(db, THEME_SETTING_KEY, choice).catch(reportError);
  }, [db, loaded, choice, reportError]);

  return null;
}
