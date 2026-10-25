/**
 * Tailwind build config — the site is styled with a pre-built, self-hosted /tailwind.css
 * (previously it loaded Tailwind's Play CDN script at runtime, which is a third-party script
 * running with full access to the page, including the admin panel).
 *
 * Rebuild after changing any Tailwind class in index.html:
 *   npx --yes tailwindcss@3.4.17 -c tailwind.config.cjs -i tailwind.input.css -o tailwind.css --minify
 */
module.exports = {
  content: ['./index.html'],
  theme: {
    extend: {
      colors: {
        brand:   { DEFAULT: '#7A4667', hover: '#9B7A8E' },
        sand:    '#B7A897',
        canvas:  '#F7F4EE',
        ink:     '#3A2A32',
        line:    '#E2D8CC',
        card:    '#EFE8E1',
        ok:      '#A7A087',
        err:     '#D7A9B2',
      },
      fontFamily: {
        display: ['"Playfair Display"', 'Georgia', 'serif'],
        body: ['"Poppins"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      transitionTimingFunction: {
        silk: 'cubic-bezier(0.22, 1, 0.36, 1)',
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
};
