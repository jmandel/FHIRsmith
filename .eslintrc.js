module.exports = {
  env: {
    browser: true,
    commonjs: true,
    es6: true,
    es2022: true,
    node: true,
    jest: true
  },
  extends: [
    'eslint:recommended'
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  globals: {
    BigInt: 'readonly'
  },
  rules: {
    'no-loss-of-precision': 'warn'
  },
  ignorePatterns: [
    'static/assets/js/**/*.js',
    'static/js/jquery*.js',
    'node_modules/',
    'dist/',
    'build/',
    'coverage/',
    '*.min.js'
  ]
};
