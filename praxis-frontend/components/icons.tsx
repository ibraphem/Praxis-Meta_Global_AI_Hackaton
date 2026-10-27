import type { SVGProps } from "react";

const paths = {
  scan: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3" />
      <path d="M7 12h10M12 7v10" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4m-4 4 4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  arrow: (
    <>
      <path d="M4 12h15m-5-5 5 5-5 5" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8" r="1.5" />
      <path d="m3 17 6-5 4 3 4-5 4 4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v.01" />
    </>
  ),
  code: (
    <>
      <path d="m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16" />
    </>
  ),
  breadboard: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16M6 8h2m8 0h2M6 12h2m8 0h2M6 16h2m8 0h2" />
    </>
  ),
  led: (
    <>
      <path d="M8 14V9a4 4 0 0 1 8 0v5M7 14h10M10 14v7m4-7v5M5 4 3 2m16 2 2-2M12 2V0" />
    </>
  ),
  resistor: (
    <>
      <path d="M1 12h5m12 0h5" />
      <rect x="6" y="8" width="12" height="8" rx="2" />
      <path d="M10 8v8m4-8v8" />
    </>
  ),
  jumper_wire: (
    <>
      <path d="M5 18V7a3 3 0 0 1 6 0v10a3 3 0 0 0 6 0V6M3 18h4v4H3zM15 2h4v4h-4z" />
    </>
  ),
} as const;

export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: keyof typeof paths }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

export function PraxisMark() {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
    >
      <rect width="36" height="36" rx="10" fill="#22251F" />
      <path
        d="M10 25V11h9a5 5 0 0 1 0 10h-5"
        stroke="#FCFBF6"
        strokeWidth="3"
      />
      <circle cx="25" cy="26" r="3" fill="#E59848" />
    </svg>
  );
}
