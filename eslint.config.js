import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import security from 'eslint-plugin-security';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**', 'public/**', 'eslint.config.js']
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    prettierConfig,
    // Phase 9 §12.2 — security rules for server-side code.
    {
        files: ['src/**/*.ts'],
        plugins: { security },
        rules: {
            ...security.configs.recommended.rules,
            // Bracket access is pervasive (validated maps/records); the TS type
            // system plus the validation layer (src/validation) are the guards.
            'security/detect-object-injection': 'off',
            // Storage backends intentionally persist to operator-configured
            // paths (ADDONS_DATA_FILE); path components never come from
            // remote input (enforced by addon slug normalization).
            'security/detect-non-literal-fs-filename': 'off',
            // Dynamic RegExp is used only on internally-validated patterns.
            'security/detect-non-literal-regexp': 'off'
        }
    },
    // Phase 9 §12.2 — import hygiene rules (order, duplicates, boundaries).
    {
        files: ['src/**/*.ts', 'test/**/*.js', 'scripts/**/*.js'],
        plugins: { import: importPlugin },
        rules: {
            'import/first': 'error',
            'import/no-duplicates': 'error',
            'import/newline-after-import': 'error',
            'import/order': [
                'error',
                {
                    groups: [
                        'builtin',
                        'external',
                        'internal',
                        'parent',
                        'sibling',
                        'index'
                    ],
                    'newlines-between': 'never'
                }
            ],
            'import/no-unresolved': ['error', { ignore: ['@omss/framework'] }],
            // Tests import the compiled artifact (../dist/...) by design —
            // see ADR 0005. `scripts/` may import dev tooling.
            'import/no-extraneous-dependencies': [
                'error',
                {
                    devDependencies: [
                        'test/**/*',
                        'scripts/**/*',
                        'eslint.config.js'
                    ]
                }
            ]
        },
        settings: {
            'import/resolver': {
                typescript: { alwaysTryTypes: true, project: './tsconfig.json' }
            },
            'import/ignore': ['node_modules']
        }
    },
    {
        rules: {
            'import/no-unresolved': 'off'
        },
        files: ['test/**/*.js']
    }
);
