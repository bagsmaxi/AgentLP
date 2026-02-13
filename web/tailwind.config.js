/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'meteora-blue': '#00D1FF',
        'meteora-purple': '#7B61FF',
        'dark': {
          900: '#0a0a0f',
          850: '#0e0e16',
          800: '#12121a',
          750: '#161624',
          700: '#1a1a2e',
          600: '#252540',
          500: '#32325a',
        },
      },
      boxShadow: {
        'glow-blue': '0 0 20px rgba(0, 209, 255, 0.15)',
        'glow-purple': '0 0 20px rgba(123, 97, 255, 0.15)',
        'glass': '0 8px 32px rgba(0, 0, 0, 0.4)',
      },
    },
  },
  plugins: [],
};
