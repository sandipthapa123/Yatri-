const base = require('./packages/config/eslint/base');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const reactNative = require('eslint-plugin-react-native');
const globals = require('globals');

const reactNativeApps = [
  'apps/passenger/**/*.{ts,tsx}',
  'apps/driver/**/*.{ts,tsx}',
  'packages/mobile-auth/**/*.{ts,tsx}',
  'packages/mobile-location/**/*.{ts,tsx}',
];
const webApps = ['apps/admin/**/*.{ts,tsx}'];

module.exports = [
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.expo/**',
      '**/node_modules/**',
      '**/coverage/**',
    ],
  },
  ...base,
  {
    // Repository maintenance scripts (ES modules run by Node).
    files: ['scripts/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // CommonJS tooling config files (babel/metro/eslint config, shared config package).
    files: [
      '**/*.config.js',
      'eslint.config.js',
      'packages/config/**/*.js',
      'apps/api/migrations/**/*.js',
    ],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.es2022, ...globals.node },
    },
  },
  {
    files: reactNativeApps,
    plugins: { react, 'react-hooks': reactHooks, 'react-native': reactNative },
    languageOptions: {
      globals: { ...globals['shared-node-browser'] },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-native/no-unused-styles': 'warn',
      'react-native/no-inline-styles': 'off',
    },
  },
  {
    files: webApps,
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
