import type { ReactNode, SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function make(children: ReactNode, filled = false) {
  return function Icon({ size = 14, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={filled ? "currentColor" : "none"}
        stroke={filled ? "none" : "currentColor"}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {children}
      </svg>
    );
  };
}

export const IconPlus = make(<path d="M12 5v14M5 12h14" />);
export const IconChevronRight = make(<path d="m9 18 6-6-6-6" />);
export const IconChevronLeft = make(<path d="m15 18-6-6 6-6" />);
export const IconChevronDown = make(<path d="m6 9 6 6 6-6" />);
export const IconX = make(<path d="M18 6 6 18M6 6l12 12" />);
export const IconCheck = make(<path d="M20 6 9 17l-5-5" />);
export const IconFile = make(<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4" />);
export const IconWarning = make(
  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4M12 17h.01" />,
);
export const IconInfo = make(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </>,
);
export const IconAlert = make(
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </>,
);
export const IconStop = make(<rect x="6" y="6" width="12" height="12" rx="2" />, true);
export const IconArrowUp = make(<path d="m5 12 7-7 7 7M12 19V5" />);
export const IconTrash = make(
  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />,
);
export const IconRefresh = make(
  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16M16 16h5v5" />,
);
export const IconShield = make(
  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
);
export const IconCopy = make(
  <>
    <rect x="8" y="8" width="14" height="14" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>,
);
export const IconLock = make(
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>,
);
export const IconUnplug = make(
  <path d="m19 5 3-3M2 22l3-3M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4ZM7.5 13.5 10 11M10.5 16.5 13 14M12 6l6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />,
);

// ---------- Swan ----------
export const IconSettings = make(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>,
);
// The swan from the app icon and favicon, drawn on their 32 grid and centred on this one.
export const IconSwan = make(
  <path transform="translate(-4 -3)" d="M9 21c3 3 11 3 14-2-3 1-6 0-7-3 0-3 2-5 1-8-1-2-4-2-5 0 2 0 3 1 2 3-1 2-3 4-2 7" />,
);
export const IconDiff = make(<path d="M12 3v12M6 9h12M6 21h12" />);
export const IconUpload = make(<path d="M12 15V3M7 8l5-5 5 5M5 21h14" />);
export const IconSearch = make(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>,
);
export const IconArrowRight = make(<path d="M5 12h14M12 5l7 7-7 7" />);
export const IconPin = make(<path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" />);
export const IconExternal = make(<path d="M7 17 17 7M8 7h9v9" />);
export const IconRepeat = make(<path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />);
export const IconPersonaAdd = make(
  <>
    <circle cx="10" cy="8" r="4" />
    <path d="M2 21a8 8 0 0 1 13-6.2M19 15v6M16 18h6" />
  </>,
);
export const IconPaperclip = make(
  <path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7L10 17.4a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />,
);
export const IconOverview = make(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9h2M7 13h2M11 9h6M11 13h6" />
  </>,
);
export const IconImage = make(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
  </>,
);
