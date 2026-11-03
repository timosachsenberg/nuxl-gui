// The theme before the first paint (src/lib/theme/theme.ts has the rules and the rest): the kept
// preference, else the system's by the media query. A classic script in <head>, so it runs before the
// page shows (the app's module comes later and also asks the window's theme).
;(function () {
  var preference = null
  try {
    preference = localStorage.getItem('prose.theme')
  } catch (e) {
    // blocked storage: System
  }
  var dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia !== undefined && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
})()
