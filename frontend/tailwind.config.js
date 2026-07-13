/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", '"Noto Sans TC"', "system-ui", "sans-serif"],
      },
      colors: {
        ink: "#17201d",
        canvas: "#f5f7f4",
        forest: "#153b32",
        mint: "#3ecf8e",
      },
      boxShadow: {
        soft: "0 16px 40px rgba(20, 45, 37, .08)",
      },
    },
  },
  plugins: [],
};
