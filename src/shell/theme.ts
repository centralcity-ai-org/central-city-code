import React, { useEffect, useState } from 'react';

/**
 * Central City Theme Controller & Interactive Utilities (v8 Design System)
 * Light by default on every device, whatever the OS colour-scheme setting. Dark only when the
 * visitor picks it with the theme toggle (stored in localStorage) or via ?theme=dark|light.
 * A URL query parameter applies to that page view only and is never written to localStorage.
 * Applied before first render (applyStoredTheme in src/main.tsx), so there is no flash.
 */

export type Theme = 'light' | 'dark';
export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'cc-theme';

/**
 * Reads the active theme preference.
 * Priority: URL query param (?theme=dark|light) -> localStorage -> 'system'.
 * A URL query param applies to that page view only and is never written to localStorage.
 */
export function getStoredThemePreference(): ThemePreference {
  try {
    if (typeof window !== 'undefined' && window.location?.search) {
      const urlParams = new URLSearchParams(window.location.search);
      const qTheme = urlParams.get('theme');
      if (qTheme === 'dark' || qTheme === 'light') {
        return qTheme;
      }
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') return stored;
    }
  } catch {
    // Environments without window/localStorage fallback safely
  }
  return 'system';
}

/**
 * The theme used when the visitor has not chosen one. Always light: the OS colour-scheme
 * setting is deliberately ignored.
 */
export function getSystemTheme(): Theme {
  return 'light';
}

/** Browser chrome colour (meta theme-color) per theme. */
const THEME_COLOR: Record<Theme, string> = { light: '#f4f6fa', dark: '#0c1426' };

/**
 * Computes the effective active theme ('light' | 'dark') based on user preference and system state.
 */
export function getEffectiveTheme(preference: ThemePreference = getStoredThemePreference()): Theme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return getSystemTheme();
}

/**
 * Applies the given theme to the document element without flashing.
 */
export function applyTheme(preference: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const effectiveTheme = getEffectiveTheme(preference);

  document.documentElement.dataset.theme = effectiveTheme;
  document.documentElement.style.colorScheme = effectiveTheme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', effectiveTheme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLOR[effectiveTheme]);

  // Update theme toggle buttons if present in DOM
  const toggleBtns = document.querySelectorAll<HTMLElement>('.theme-toggle-btn, .theme-toggle');
  const label = effectiveTheme === 'dark' ? 'Use light theme' : 'Use dark theme';
  const title = `Switch to ${effectiveTheme === 'dark' ? 'light' : 'dark'} mode`;
  toggleBtns.forEach((btn) => {
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', title);
  });
}

/**
 * Applies the stored theme immediately before first paint; call once at app startup.
 */
export function applyStoredTheme(): void {
  const preference = getStoredThemePreference();
  applyTheme(preference);
}

/**
 * Saves a new theme preference and applies it to the document.
 */
export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Storage might be unavailable
  }
  applyTheme(preference);
}

/**
 * React hook to observe and update the theme preference.
 */
export function useTheme() {
  const [preference, setPrefState] = useState<ThemePreference>(getStoredThemePreference);
  const [effectiveTheme, setEffectiveState] = useState<Theme>(() => {
    if (typeof document !== 'undefined') {
      const current = document.documentElement.dataset.theme;
      if (current === 'dark' || current === 'light') return current;
    }
    return getEffectiveTheme(preference);
  });

  // Keep every mounted toggle in step when another one changes the theme.
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const current: Theme = root.dataset.theme === 'dark' ? 'dark' : 'light';
      setEffectiveState((prev) => (prev === current ? prev : current));
    };
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const setPreference = (next: ThemePreference) => {
    setPrefState(next);
    setEffectiveState(getEffectiveTheme(next));
    setThemePreference(next);
  };

  const toggleTheme = () => {
    const next: ThemePreference = effectiveTheme === 'dark' ? 'light' : 'dark';
    setPreference(next);
  };

  return {
    preference,
    effectiveTheme,
    isDark: effectiveTheme === 'dark',
    setPreference,
    toggleTheme,
  };
}

/**
 * Minimalist v8 Theme Toggle Button
 * Renders the clean SVG moon/sun icon and switches seamlessly between light and dark modes.
 * Built via React.createElement to keep src/shell/theme.ts as pure TypeScript.
 */
export function ThemeToggle({ className }: { className?: string }): React.JSX.Element {
  const { isDark, toggleTheme } = useTheme();

  const icon = isDark
    ? React.createElement(
        'svg',
        { viewBox: '0 0 24 24', 'aria-hidden': 'true', width: 16, height: 16 },
        React.createElement('path', {
          fill: 'currentColor',
          d: 'M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37a.996.996 0 0 0-1.41 0 .996.996 0 0 0 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0a.996.996 0 0 0 0-1.41l-1.06-1.06zm1.06-10.96a.996.996 0 0 0-1.41-1.41l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36a.996.996 0 0 0-1.41-1.41l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z',
        }),
      )
    : React.createElement(
        'svg',
        { viewBox: '0 0 24 24', 'aria-hidden': 'true', width: 16, height: 16 },
        React.createElement('path', {
          fill: 'currentColor',
          d: 'M12.3 2a10 10 0 0 0-.19 20 10 10 0 0 0 8.7-5.2 1 1 0 0 0-1.07-1.48 8 8 0 1 1-7.92-12.25 1 1 0 0 0 .48-1.07z',
        }),
      );

  return React.createElement(
    'button',
    {
      id: 'themeToggle',
      type: 'button',
      className: `theme-toggle-btn icon-button theme-toggle ${className ?? ''}`.trim(),
      onClick: toggleTheme,
      'aria-label': isDark ? 'Use light theme' : 'Use dark theme',
      title: isDark ? 'Switch to light mode' : 'Switch to dark mode',
    },
    icon,
  );
}
