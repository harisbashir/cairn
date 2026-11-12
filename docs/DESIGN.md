# Cairn design notes

Thesis: **you always know where you are.** A cairn marks the trail; the interface does the same.
The one thing Cairn should be remembered by is its wayfinding: a full breadcrumb trail on every
page, a sidebar that reveals the current page, and one search box (⌘K) that finds or creates anything.

Reviewed against Apple's Human Interface Guidelines as principles for a web app (foundations and
design principles apply; Apple platform conventions do not).

## Rules

- **One accent, one meaning.** Blue (`--accent`) marks the primary action and the current location,
  nothing else. Violet (`--ai`) is reserved for "an AI agent did this". Red is destructive only.
- **System type.** Navigation and controls use the system font at 14 px (13 px minimum for
  secondary labels, never below 12 px). Page content is 16 px. Hierarchy comes from weight and size.
- **Contrast.** Body text `#1f2430` on white is 15.6:1; secondary `#565f73` is 6.6:1; tertiary
  `#6b7385` is 4.8:1. Dark mode values are chosen to hold the same floors. Light and dark follow
  the system setting; there is no in-app switch.
- **Targets.** Controls are at least 28 x 28 px, primary buttons 32 px, large actions 40 px.
- **Nothing by colour alone.** Status chips carry their name; AI edits carry an "AI" label.
- **Sidebar.** Two groups (Workspace, Private) plus Favorites. Can be hidden (⌘\). No critical
  action lives only at its bottom: settings and sign-out are also in the workspace menu and ⌘K.
- **Feedback in place.** Saving state sits in the top bar. Deleting goes to Trash with an Undo
  toast; only permanent deletion asks for confirmation, and the confirm button names the action.
- **Writing.** Buttons use title case and say what happens ("Create Invite Link", "Delete Forever").
  Errors say what went wrong in plain language.
- **Motion.** 120-180 ms fades and scales on menus and dialogs only; disabled under
  `prefers-reduced-motion`.

## Brand

Mark: three stacked stones, the top one in the accent colour. Files in `brand/`. The mark appears
once per screen at most (sign-in, public pages); inside the app the workspace's own badge leads.
