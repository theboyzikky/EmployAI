export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "eai-theme";

/**
 * Inline script placed in <head>; runs before first paint so there is no flash of the wrong theme.
 * Dark Mode is the default for first-time visitors. A theme the visitor picked with the toggle is
 * stored and always wins on later visits, navigations and refreshes.
 */
export const DEFAULT_THEME: Theme = "dark";
export const THEME_INIT_SCRIPT = `(function(){var d=${JSON.stringify(DEFAULT_THEME)};try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});document.documentElement.setAttribute("data-theme",t==="light"||t==="dark"?t:d)}catch(e){document.documentElement.setAttribute("data-theme",d)}})();`;
