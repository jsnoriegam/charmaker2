import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', '.venv/**', 'generated/**', 'data/**', 'public/vendor/**', '**/*.min.js'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // app.js / i18n.js son scripts clásicos: exponen app() / i18n en globalThis.
    files: ['public/app.js', 'public/i18n.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
];
