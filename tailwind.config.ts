import type { Config } from "tailwindcss"
import tailwindcssAnimate from "tailwindcss-animate"

export default {
  darkMode: ["class"],
  content: ["./src/renderer/index.html", "./src/renderer/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // These map straight onto the CSS custom properties the design comp
        // (new-ui/Mod Manager.dc.html) uses, kept as plain var() rather than
        // shadcn's usual hsl(var(--x)) triplets since the theme engine
        // (src/renderer/src/lib/theme.ts) computes final hex/rgba values at
        // runtime for light/dark x 5 accent combinations, same as the comp's
        // applyTheme().
        "app-bg": "var(--app-bg)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        "surface-hover": "var(--surface-hover)",
        border: "var(--border)",
        text: "var(--text)",
        "text-2": "var(--text-2)",
        "text-3": "var(--text-3)",
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          foreground: "var(--accent-fg)",
          soft: "var(--accent-soft)"
        },
        danger: "var(--danger)",
        warning: "var(--warning)",
        success: "var(--success)"
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)"
      },
      borderRadius: {
        lg: "12px",
        md: "8px",
        sm: "6px"
      },
      fontFamily: {
        sans: ["Segoe UI Variable", "Segoe UI", "Inter", "system-ui", "sans-serif"],
        mono: ["Cascadia Code", "Consolas", "monospace"]
      },
      keyframes: {
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } }
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out"
      }
    }
  },
  plugins: [tailwindcssAnimate]
} satisfies Config
