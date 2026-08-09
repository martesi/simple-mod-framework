import js from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"

export default defineConfig(
	// globalIgnores() (not a bare `{ ignores: [...] }`) - ESLint's own flat-config docs point out
	// that `ignores` alone in an object is ambiguous between "global ignore" and "local ignore
	// scoped to everything else in this same object" until you reach for the explicit helper. See
	// https://eslint.org/blog/2025/03/flat-config-extends-define-config-global-ignores/.
	// src/renderer/src/locales is Lingui's own generated output (npm run i18n:extract/i18n:compile)
	// - linting messages.mjs/messages.po as if they were hand-written source is pure noise.
	globalIgnores(["dist", "out", "src/renderer/src/locales"]),
	{
		// Every TS/TSX file in the repo (main, preload, and renderer alike) gets ESLint's own and
		// typescript-eslint's recommended rules - these are equally meaningful for plain Node code
		// (src/main/core) as for React code.
		files: ["**/*.{ts,tsx}"],
		extends: [js.configs.recommended, tseslint.configs.recommended],
		languageOptions: {
			ecmaVersion: 2022,
			globals: { window: "readonly", document: "readonly", localStorage: "readonly", crypto: "readonly" }
		},
		rules: {
			"@typescript-eslint/no-unused-vars": "off",
			"@typescript-eslint/no-explicit-any": "off"
		}
	},
	{
		// react-hooks/react-refresh only mean anything where React actually runs - scoping to
		// src/renderer/src (rather than the previous "**/*.{ts,tsx}", which applied these to
		// src/main/core's plain Node code too) avoids false-positive noise from the React Compiler's
		// rules below on code that was never going to be a React component in the first place
		// (src/main/core is full of exactly the imperative mutation/side-effect patterns those rules
		// are designed to flag in *React* code).
		files: ["src/renderer/src/**/*.{ts,tsx}"],
		// "recommended-latest" (as opposed to "recommended") is what pulls in the React Compiler's
		// own lint rules (purity/immutability/preserve-manual-memoization/etc.) - these used to ship
		// as a separate eslint-plugin-react-compiler package, but that's still only at a 19.x RC;
		// React folded the same rules into eslint-plugin-react-hooks itself (7.x+) instead, and
		// that's now the officially documented way to get them - see
		// https://react.dev/learn/react-compiler/installation#eslint-integration.
		extends: [reactHooks.configs.flat["recommended-latest"]],
		plugins: { "react-refresh": reactRefresh },
		rules: {
			"react-refresh/only-export-components": "warn"
		}
	},
	{
		// These shadcn-style files intentionally export compound primitive aliases (Root, Trigger,
		// Value, etc.) alongside their wrapper components. Fast Refresh treats those aliases as
		// non-component exports, but splitting every primitive into a separate file would make the
		// component API harder to use without changing runtime behavior.
		files: ["src/renderer/src/components/ui/**/*.{ts,tsx}"],
		rules: { "react-refresh/only-export-components": "off" }
	}
)
