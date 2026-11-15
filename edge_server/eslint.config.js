// ESLint configuration (flat config). Run with: npm run lint
// Checks for mistakes (undefined or unused names, unreachable code, ...),
// not for layout: no formatting rules are enabled.
const js = require('@eslint/js');
const globals = require('globals');

const unusedVars = ['error', {
  args: 'after-used',
  argsIgnorePattern: '^_',
  caughtErrors: 'none',
  varsIgnorePattern: '^_'
}];

module.exports = [
  {
    ignores: ['node_modules/**', 'public/lib/**']
  },

  // Edge server, database scripts, tools and tests: Node.js, CommonJS
  {
    files: ['**/*.js'],
    ignores: ['public/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': unusedVars
    }
  },

  // Dashboard: plain browser scripts loaded by index.html, sharing globals
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // html_safety.js
        escapeHtml: 'readonly',
        imgFallbackAttrs: 'readonly',
        actionAttrs: 'readonly',
        // modal.js
        showToast: 'readonly',
        showModal: 'readonly',
        // ward_canvas.js / ward_controller.js
        redrawWardMap: 'readonly',
        // ward_live_map.js (assigned to window, called from inline handlers)
        resetCalibrationStep: 'readonly',
        onCalibrationLandmarkChanged: 'readonly',
        closeCalibrationModal: 'readonly',
        openCalibrationModal: 'readonly',
        startCalibrationSession: 'readonly',
        applyCalibrationResults: 'readonly',
        resetAnchorCalibrationToDefault: 'readonly'
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': unusedVars,
      // The files that define the shared globals above may declare them
      'no-redeclare': ['error', { builtinGlobals: false }]
    }
  }
];
