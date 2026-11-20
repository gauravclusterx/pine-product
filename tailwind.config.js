/** Pine AI design tokens — a calm lavender canvas, near-black type, a fresh green for action. */
export default {
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#0b0b0b", soft: "#3d3a45", mute: "#6f6a7a" },
        canvas: { DEFAULT: "#f4f3f7", deep: "#eceaf1", line: "#e2dfe8", card: "#ffffff", tint: "#fbfafd" },
        leaf: { DEFAULT: "#699909", dark: "#557c07", light: "#a9d46a", wash: "#eef6df" },
        plum: { DEFAULT: "#5a1e96", soft: "#b996e6", wash: "#f3ecfc" },
        warn: { DEFAULT: "#b45309", wash: "#fef3c7" },
        bad: { DEFAULT: "#b42318", wash: "#fee4e2" },
      },
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"], display: ["Geist", "Inter", "ui-sans-serif", "system-ui", "sans-serif"] },
      borderRadius: { xl: "0.75rem", "2xl": "1.25rem", "3xl": "2rem" },
      boxShadow: { card: "0 1px 2px rgba(16,12,24,.04), 0 1px 1px rgba(16,12,24,.03)", lift: "0 8px 30px rgba(40,20,70,.08)" },
    },
  },
  plugins: [],
};
