/**
 * The selected Central City mark. It is the supplied raster silhouette (brandbook v2, p07),
 * rendered through a CSS mask so one asset serves Central Blue, white-on-dark and ink variants
 * without redrawing or tracing the geometry.
 */
export function CityMark({ small = false, label }: { small?: boolean; label?: string }) {
  return (
    <span
      className={small ? 'city-mark small' : 'city-mark'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** Horizontal lockup: mark plus the Inter wordmark (gap 0.25H, cap height about 0.4H). */
export function Lockup({
  href,
  onClick,
  label,
}: {
  href?: string;
  onClick?: () => void;
  label?: string;
}) {
  const content = (
    <>
      <CityMark />
      <span className="lockup-word">Central City</span>
    </>
  );
  if (onClick)
    return (
      <button type="button" className="lockup" onClick={onClick} aria-label={label}>
        {content}
      </button>
    );
  return (
    <a className="lockup" href={href ?? '#'} aria-label={label}>
      {content}
    </a>
  );
}

/** Moves focus to the main landmark without changing the hash route. */
export function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#main-content"
      onClick={(event) => {
        event.preventDefault();
        const main = document.getElementById('main-content');
        main?.focus();
        main?.scrollIntoView();
      }}
    >
      Skip to content
    </a>
  );
}

export {
  type Theme,
  type ThemePreference,
  applyStoredTheme,
  applyTheme,
  getEffectiveTheme,
  getStoredThemePreference,
  getSystemTheme,
  setThemePreference,
  useTheme,
  ThemeToggle,
} from './shell/theme';
