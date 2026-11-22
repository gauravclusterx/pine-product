/**
 * Pine AI design tokens — "forest glass": a deep evergreen canvas, frosted glass panels,
 * warm off-white type, and a soft sage for action and good news. Montaga for display numbers.
 *
 * Token names are kept from the first theme (ink = text, canvas = surfaces, leaf = accent) so
 * every page follows the palette without per-page colour classes.
 */
export default {
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#F2F6F0", soft: "#C8D3C5", mute: "#8E9E8F" },
        canvas: {
          DEFAULT: "#0B1409",
          deep: "rgba(255,255,255,0.06)",
          line: "rgba(255,255,255,0.10)",
          card: "rgba(255,255,255,0.045)",
          tint: "rgba(255,255,255,0.08)",
          solid: "#121D10",
        },
        leaf: { DEFAULT: "#B7D3A8", dark: "#CFE5C1", light: "#DCEBD2", wash: "rgba(183,211,168,0.14)", deep: "#29561F" },
        plum: { DEFAULT: "#D7C6F2", soft: "#9C86C9", wash: "rgba(215,198,242,0.12)" },
        warn: { DEFAULT: "#F0C987", wash: "rgba(240,201,135,0.12)" },
        bad: { DEFAULT: "#F2A49B", wash: "rgba(242,164,155,0.12)" },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Montaga", "Georgia", "serif"],
      },
      borderRadius: { xl: "0.75rem", "2xl": "1rem", "3xl": "1.375rem" },
      boxShadow: {
        card: "inset 0 0 0 1px rgba(255,255,255,0.09)",
        lift: "inset 0 0 0 1px rgba(255,255,255,0.12), 0 30px 80px -30px rgba(0,0,0,0.7)",
        glow: "inset 0 0 0 1px rgba(183,211,168,0.35)",
      },
    },
  },
  plugins: [],
};
