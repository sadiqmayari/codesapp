// WooCommerce glyph in brand purple (FontAwesome fa-wordpress-simple-derived
// "Woo" mark simplified to a single recognizable bubble). lucide-react has no
// brand icons; this mirrors ShopifyIcon so the composer/store UI reads at a
// glance which provider a store belongs to.
export function WooCommerceIcon({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      aria-hidden="true"
      role="img"
    >
      <path
        fill="#7F54B3"
        d="M47.6 96C21.3 96 0 117.4 0 143.6v168.8C0 338.7 21.3 360 47.6 360H192l72 56-16-56h216.4c26.3 0 47.6-21.3 47.6-47.6V143.6C512 117.4 490.7 96 464.4 96H47.6z"
      />
      <path
        fill="#FFF"
        d="M84 168c3-10 9-15 18-16 16-1 25 6 27 22 7 44 14 83 22 116l49-93c5-8 10-13 17-13 10-1 16 5 19 19 6 30 13 56 21 80 6-55 15-95 28-120 4-9 10-13 18-14 6-1 12 1 17 5 5 4 8 9 8 15 0 5-1 9-3 13-8 16-15 42-20 80-5 36-7 64-6 83 0 6-1 11-3 15-3 5-7 8-13 8-7 1-13-2-20-9-23-24-42-60-55-108-16 31-28 55-35 70-13 26-25 39-34 40-6 1-11-4-16-13-11-29-24-85-37-166-1-6 0-11 2-14z"
      />
    </svg>
  );
}
