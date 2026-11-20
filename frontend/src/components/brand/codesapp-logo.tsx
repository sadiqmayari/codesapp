// CodesApp brand mark ("Growth C") + wordmark.
// Geometry matches the brand kit in /public/logo (generated from one source:
// an open C ring in green with a rising cyan arrow). Keep the two in sync.

const GREEN = '#12B76A';
const CYAN = '#22B8CF';

export function CodesAppMark({
  size = 32,
  title,
  className,
}: {
  size?: number;
  /** Accessible name; omit when the mark sits next to visible "CodesApp" text. */
  title?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path
        d="M44.79 20.46 A30 30 0 1 0 78.19 60.26"
        fill="none"
        stroke={GREEN}
        strokeWidth={15}
        strokeLinecap="round"
      />
      <polyline
        points="35,58 46,48 55,56 76,30"
        fill="none"
        stroke={CYAN}
        strokeWidth={9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points="64,28 78,28 78,42"
        fill="none"
        stroke={CYAN}
        strokeWidth={9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Mark + "codesapp" wordmark. Text uses the app font and recolours in dark mode. */
export function CodesAppLogo({
  size = 32,
  className,
}: {
  /** Height of the mark in px; the wordmark scales with it. */
  size?: number;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <span className="sr-only">CodesApp</span>
      <CodesAppMark size={size} />
      <span
        className="font-extrabold tracking-tight text-gray-900"
        style={{ fontSize: Math.round(size * 0.72), letterSpacing: '-0.03em', lineHeight: 1 }}
        aria-hidden="true"
      >
        codes<span style={{ color: GREEN }}>app</span>
      </span>
    </span>
  );
}
