/* Runs before first paint so a saved light theme never flashes dark. */
;(function () {
  try {
    var key = 'till.theme'
    var stored = localStorage.getItem(key)
    var pref =
      stored === 'light' || stored === 'dark' || stored === 'system'
        ? stored
        : 'light'
    var dark =
      pref === 'dark'
        ? true
        : pref === 'light'
          ? false
          : window.matchMedia('(prefers-color-scheme: dark)').matches
    var root = document.documentElement
    root.dataset.theme = dark ? 'dark' : 'light'
    root.style.colorScheme = dark ? 'dark' : 'light'
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', dark ? '#0b2b43' : '#f7fcff')
    var iosBar = document.querySelector(
      'meta[name="apple-mobile-web-app-status-bar-style"]',
    )
    if (iosBar) iosBar.setAttribute('content', dark ? 'black-translucent' : 'default')
  } catch (e) {
    /* No storage: the light palette in index.css is the safe default. */
  }
})()
