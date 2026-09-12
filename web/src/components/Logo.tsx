interface LogoProps {
  size?: number;
}

/**
 * ComfyFed mark: a hexagonal federation boundary with a central dispatcher
 * node linked to three peer workers.
 */
export function Logo({ size = 28 }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="ComfyFed"
    >
      <path
        d="M16 4 26.4 10v12L16 28 5.6 22V10z"
        stroke="var(--mantine-color-federation-4)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M16 9.6v3.6M18.9 17.9l3.9 2.2M13.1 17.9l-3.9 2.2"
        stroke="var(--mantine-color-federation-7)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="3.2" fill="var(--mantine-color-federation-4)" />
      <circle cx="16" cy="7.4" r="2" fill="var(--mantine-color-teal-4)" />
      <circle cx="22.9" cy="21.2" r="2" fill="var(--mantine-color-teal-4)" />
      <circle cx="9.1" cy="21.2" r="2" fill="var(--mantine-color-teal-4)" />
    </svg>
  );
}
