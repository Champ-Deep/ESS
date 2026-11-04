# Dropdown-collapse design contract

## 1. Visual theme
Preserve the existing ESS workspace. This is spec items 2, 5, 8 and 9 only, not a rebrand. PRODUCT.md and ess-tokens.css remain the design authority per the approved card exception.

## 2. Color roles
Use existing --ess-surface, --ess-text, --ess-text-secondary, --ess-primary-soft, --ess-primary-text, --ess-border, --ess-danger and --ess-warning. Explicit foreground/background pairs on menus support both themes. No new palette.

## 3. Typography
Inherit the app font and existing body/caption tokens. Preserve widget headings and copy.

## 4. Components
Native details/summary for Display, More on your month and Recent admin activity. Shared disclosure.css. NavMenu is the approved Svelte-native port of 21st.dev Origin UI Dropdown Menu, demo 383: https://21st.dev/@originui/components/dropdown-menu. Native auto popovers supply outside dismissal and top-layer placement. Arrow keys, Home, End, type-to-first-letter, Escape and Tab are supported. No new dependencies.

## 5. Layout
Admin navigation wraps rather than scrolling horizontally. Overview is full width. New is in the overview header only, preserving the former task list scope. Home retains FutureEvents and ChampCard in a two-column row, with the two moved widgets below in a disclosure.

## 6. Depth
Existing ESS elevation and radius tokens only. Menus overlay the page and clamp to viewport bounds.

## 7. Guardrails
Preserve every capability, route, task URL, data prop and widget handler. Display defaults closed. Home and admin activity default closed unless the user has explicitly persisted open. No database, auth or framework changes.

## 8. Responsive behavior
Pointer and touch browser surfaces. Test 375, 390, 768, 1280 and 1440 widths. New menu controls and disclosure summaries have 44px minimum height. Home sections stack below 720px. Motion budget: no new animation; reduced-motion supported by omission. Native popovers require browsers supporting the Popover API.

## 9. Agent guide
Do not merge sibling TopBar, dashboard or admin label work into this branch. Keep the inherited ESS visual system. Review measured clipping and functional reachability, not merely mounted element presence. Container-size widgets moved out of their fixed rows need natural content sizing.
